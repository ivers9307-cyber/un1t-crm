import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { z } from 'zod'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { setWhatsAppUserBlockState } from '@/lib/whatsapp'
import { whatsappErrorStatus } from '@/lib/whatsapp-number-missing'

const BlockSchema = z.object({ action: z.enum(['block', 'unblock']) })

// POST /api/whatsapp/conversations/[id]/block — block/unblock the sender at
// Meta (Block API) and mirror the state locally (conversation.is_blocked +
// contacts.wa_status). Blocking is the inbox spam/abuse action and protects
// the number's quality rating. Registered in src/lib/openapi.js.
export const POST = withAuth({ permission: null, location: false }, async ({ user, request, params }) => {
  // INBOXLOC.1 — coarse pre-check (WhatsApp at any studio); the decision is
  // requireWhatsAppInboxAt at the conversation's studio, once the row is read.
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, BlockSchema)
  if (!validation.ok) return validation.response
  const blocked = validation.data.action === 'block'

  const db = createServerClient()
  const { data: conversation } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone, is_blocked')
    .eq('id', params.id)
    .maybeSingle()
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  // INBOXLOC.1 — WhatsApp (web or mobile) judged at THIS studio, not the active one.
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  try {
    // Block on the number this thread talks through (Meta blocks per business number).
    await setWhatsAppUserBlockState(conversation.wa_phone, blocked, { locationId: conversation.location_id, replyInConversation: conversation.id })
  } catch (e) {
    // WACONFIGFALLBACK.1 — a location with no WhatsApp number of its own is a
    // 409: the Block API on the env number blocked the sender on ANOTHER
    // studio's number. Nothing is mirrored locally.
    // A no-number refusal (409) is our own setup message; Meta's error text is
    // logged, never answered.
    const status = whatsappErrorStatus(e, 502)
    if (status !== 409) logError('wa-block', 'Meta block call failed', { conversationId: conversation.id, err: e?.message })
    return NextResponse.json({ success: false, error: status === 409 ? e.message : 'Meta block call failed' }, { status })
  }

  await db.from('whatsapp_conversations').update({ is_blocked: blocked }).eq('id', conversation.id)
  if (conversation.contact_id) {
    // Mirror onto the contact so every send path's wa_status gate applies.
    try {
      await db.from('contacts')
        .update({ wa_status: blocked ? 'blocked' : 'active' })
        .eq('id', conversation.contact_id)
    } catch (e) { console.error('[wa-block] contact wa_status update failed:', e?.message) }
  }

  return NextResponse.json({ success: true, data: { is_blocked: blocked } })
})
