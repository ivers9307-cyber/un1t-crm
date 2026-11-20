import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { validateBody } from '@/lib/validate'
import { AssignBodySchema, assignThread, assignPickerFor } from '@/lib/inbox-assignment'
import { loadConversationForUser } from '../../_conversation'

// /api/email/mail/[id]/assign — who owns this conversation (INBOXASSIGN.1;
// the ticket-era EMAIL-ASSIGN.1 routes were deleted with the ticket queue in
// RETIRE-TICKETS.2, and Mail never had a replacement).
//   GET  → { assigned_to, assignee_name, viewer_id, staff: [{ id, full_name }] }
//   POST { assignee: 'me' | null | <profile id> } → { assigned_to, assignee_name }
//
// The gate is every Mail detail route's: loadConversationForUser — studio
// membership, `email_inbox` at the CONVERSATION'S studio and sight of its
// mailbox, every refusal a 404. A merged-away conversation is a tombstone and
// takes no owner (409, like a send). The inbound-mail push pages only the
// owner of an assigned conversation (EMAIL-PUSH-ASSIGNEE.1).

function mergedAway() {
  return NextResponse.json({
    success: false,
    error: 'This conversation was merged into another one. Assign the conversation it was merged into.',
  }, { status: 409 })
}

// withAuth only signs the caller in (permission: null, no studio): the gate is
// loadConversationForUser at the conversation's studio, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const loaded = await loadConversationForUser(db, user, params?.id)
  if (loaded.response) return loaded.response
  const out = await assignPickerFor(db, { channel: 'mail', user, thread: loaded.conversation })
  return NextResponse.json(out.body, { status: out.status })
})

// The body is read before the conversation, as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const validation = await validateBody(request, AssignBodySchema)
  if (!validation.ok) return validation.response
  const loaded = await loadConversationForUser(db, user, params?.id)
  if (loaded.response) return loaded.response
  if (loaded.conversation.merged_into_id) return mergedAway()
  const out = await assignThread(db, {
    channel: 'mail', user, thread: loaded.conversation, assignee: validation.data.assignee,
  })
  return NextResponse.json(out.body, { status: out.status })
})
