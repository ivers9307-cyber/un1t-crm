import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { SnoozeSchema } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { snoozeUpdateFor, NEW_MESSAGE_ERROR } from '@/lib/inbox-snooze-request'

// POST /api/instagram/conversations/[id]/snooze — snooze a thread until a time
// ({ until, note? }) or clear the snooze ({ until: null }). The phone calls it
// too, so the gates are the send route's: the inbox key (the `whatsapp` key
// serves both channels; web or phone) held at ANY studio before the body and
// the read, the thread's studio (404), then the key at that studio
// (INBOXPERM.1). withAuth only signs the caller in.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, SnoozeSchema)
  if (!validation.ok) return validation.response

  const { data: conversation, error } = await db.from('instagram_conversations')
    .select('id, location_id, resolved_at, last_message_at, last_message_direction')
    .eq('id', params?.id)
    .single()
  if (error || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  const update = snoozeUpdateFor(validation.data, conversation, { userId: user.id })
  if (update.error) return NextResponse.json({ success: false, error: update.error }, { status: update.status })

  let query = db.from('instagram_conversations')
    .update(update.patch)
    .eq('id', conversation.id)
  // The coach said what they had seen: only write if no message has landed since the read.
  const lastMessageGuard = update.lastMessageGuard
  if (lastMessageGuard) query = lastMessageGuard.value === null ? query.is('last_message_at', null) : query.eq('last_message_at', lastMessageGuard.value)
  const { data: row, error: updateError } = await query
    .select('snoozed_until, snooze_note')
    .maybeSingle()
  if (updateError) {
    logError('instagram', 'snooze not saved', { conversationId: conversation.id, code: updateError.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not change the snooze on this conversation. Try again.' }, { status: 500 })
  }
  // A zero-row update is not an error to supabase-js. With the last-message
  // condition it means a message landed since the read; otherwise the thread vanished.
  if (!row && lastMessageGuard) return NextResponse.json({ success: false, error: NEW_MESSAGE_ERROR }, { status: 409 })
  if (!row) return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: { snoozed_until: row.snoozed_until, snooze_note: row.snooze_note } })
})
