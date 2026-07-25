import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { sendReaction } from '@/lib/whatsapp'

// Empty emoji is valid — it removes an existing reaction — so no .min().
const ReactSchema = z.object({ message_id: z.string().min(1), emoji: z.string().max(8) })

// POST /api/whatsapp/conversations/[id]/react — react to a customer message
// with an emoji via Meta (empty string removes the reaction), then best-effort
// log a thread row (matching the inbound 'reaction' row style) so the action
// is visible in the inbox. Registered in src/lib/openapi.js.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'wa')
  if (perm) return perm

  const validation = await validateBody(request, ReactSchema)
  if (!validation.ok) return validation.response
  const { message_id, emoji } = validation.data

  const db = createServerClient()
  const { data: conversation } = await db.from('whatsapp_conversations')
    .select('id, location_id, contact_id, wa_phone')
    .eq('id', params.id)
    .maybeSingle()
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  let sendResult
  try {
    sendResult = await sendReaction(conversation.wa_phone, message_id, emoji, { locationId: conversation.location_id })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Meta reaction call failed' }, { status: 502 })
  }

  // Best-effort thread row — mirrors the inbound reaction style
  // (`Reacted: <emoji>`); a logging failure never fails the action.
  // wa_message_id lets the reaction's 'sent' status webhook match the row.
  try {
    await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: conversation.contact_id || null,
      location_id: conversation.location_id,
      wa_message_id: sendResult?.messageId || null,
      direction: 'outbound',
      message_type: 'reaction',
      body: emoji ? `Reacted: ${emoji}` : 'Removed reaction',
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
  } catch (e) { console.error('[wa-react] thread row insert failed:', e?.message) }

  return NextResponse.json({ success: true })
}
