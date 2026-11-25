import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { SnoozeSchema } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { snoozeUpdateFor } from '@/lib/inbox-snooze-request'

// POST /api/whatsapp/conversations/[id]/snooze — snooze a thread until a time
// ({ until, note? }) or clear the snooze ({ until: null }). The phone calls it
// too, so the gates are the send route's: WhatsApp (web or mobile) at any
// studio before the read, membership (404) once the row is read, then the
// permission at the thread's own studio. withAuth only signs the caller in.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, SnoozeSchema)
  if (!validation.ok) return validation.response

  const { data: conversation, error } = await db.from('whatsapp_conversations')
    .select('id, location_id, resolved_at')
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

  const { data: row, error: updateError } = await db.from('whatsapp_conversations')
    .update(update.patch)
    .eq('id', conversation.id)
    .select('snoozed_until, snooze_note')
    .maybeSingle()
  if (updateError) {
    logError('whatsapp', 'snooze not saved', { conversationId: conversation.id, code: updateError.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not change the snooze on this conversation. Try again.' }, { status: 500 })
  }
  // A zero-row update is not an error to supabase-js: the thread vanished.
  if (!row) return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: { snoozed_until: row.snoozed_until, snooze_note: row.snooze_note } })
})
