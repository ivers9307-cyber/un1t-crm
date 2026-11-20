// POST /api/whatsapp/conversations/[id]/attachments/sign
//
// WAATTACH.1 — step 1 of sending a photo or PDF from the WhatsApp inbox (the
// flow is in src/lib/wa-outbound-attachment.js). The browser declares the
// file; this route judges it, mints a slot in the PRIVATE whatsapp-media
// bucket under the CONVERSATION's studio, and returns a signed upload token
// for exactly that path. The bucket has no client policy (migs 325, 403), so
// the token is the only way in, and the server picks where the bytes land.
//
// Gate: WhatsApp at any studio (coarse) → the conversation read → membership
// of its studio (404, ids not enumerable) → WhatsApp at that studio
// (requireWhatsAppInboxAt), the same order as the send route. A closed 24-hour
// window is refused here too, before anything is uploaded.
//
// Body: { file_name, mime, size } → { success: true, data: { path, token, content_type, kind } }

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { randomUUID } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { isWindowOpen } from '@/lib/whatsapp'
import { logError } from '@/lib/log'
import { WHATSAPP_MEDIA_BUCKET } from '@shared/whatsapp-media'
import { WA_ATTACHMENT_TEXT, buildWaAttachmentPath, judgeWaAttachment } from '@/lib/wa-outbound-attachment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WaAttachmentSignSchema = z.object({
  file_name: z.string().min(1).max(300),
  mime: z.string().max(200),
  size: z.number().int(),
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, request, params }) => {
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, WaAttachmentSignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('id, location_id, window_expires_at')
    .eq('id', params.id)
    .maybeSingle()
  if (error) {
    logError('wa-attach-sign', 'conversation read failed', { conversationId: params.id, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not read the conversation. Try again.' }, { status: 500 })
  }
  if (!conversation) return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  if (!isWindowOpen(conversation)) {
    return NextResponse.json({ success: false, error: WA_ATTACHMENT_TEXT.windowClosed, window_expired: true }, { status: 400 })
  }

  const judged = judgeWaAttachment({ mime: body.mime, size: body.size })
  if (!judged.ok) return NextResponse.json({ success: false, error: judged.error }, { status: 400 })

  const path = buildWaAttachmentPath({
    locationId: conversation.location_id, conversationId: conversation.id, id: randomUUID(), ext: judged.ext,
  })
  let signed = null
  try {
    const { data, error: signErr } = await db.storage.from(WHATSAPP_MEDIA_BUCKET).createSignedUploadUrl(path)
    if (signErr) logError('wa-attach-sign', 'signed upload url failed', { conversationId: conversation.id, err: signErr.message })
    else signed = data
  } catch (err) {
    logError('wa-attach-sign', 'signed upload url threw', { conversationId: conversation.id, err: err?.message })
  }
  if (!signed?.token) {
    return NextResponse.json({ success: false, error: 'Could not start the upload. Try again.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    data: { path, token: signed.token, content_type: judged.contentType, kind: judged.kind },
  })
})
