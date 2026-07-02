import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { setWhatsAppUserBlockState } from '@/lib/whatsapp'

const BlockSchema = z.object({ action: z.enum(['block', 'unblock']) })

// POST /api/whatsapp/conversations/[id]/block — block/unblock the sender at
// Meta (Block API) and mirror the state locally (conversation.is_blocked +
// contacts.wa_status). Blocking is the inbox spam/abuse action and protects
// the number's quality rating. Registered in src/lib/openapi.js.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

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

  try {
    await setWhatsAppUserBlockState(conversation.wa_phone, blocked, { locationId: conversation.location_id })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta block call failed' }, { status: 502 })
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
}
