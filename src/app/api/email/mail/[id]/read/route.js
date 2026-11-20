import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadConversationForUser } from '../../_conversation'

// POST /api/email/conversations/[id]/read — zero the unread badge
// (EMAIL-TICKET.4).
//
// Its own endpoint rather than a side effect of the detail GET, so opening a
// conversation to read it is an explicit, idempotent action and the GET stays free
// of writes. Same 404 rules as every other conversation route.
//
// updated_at is deliberately NOT bumped: reading a conversation is not a change to
// it, and bumping it would reorder any queue sorted on it.
//
// BOTH GATES LIVE IN loadConversationForUser (EMAIL-TICKET-CLEANUP.1) — the
// `email_inbox` surface permission resolved at the TICKET'S location, and the
// per-mailbox grant. The permission check used to sit here, above the load,
// where it could only ever resolve at the caller's ACTIVE location and so
// answered a different question than this route asks.
// withAuth only signs the caller in (permission: null): both gates are judged
// at the conversation's studio inside loadConversationForUser, as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const loaded = await loadConversationForUser(db, user, params?.id)
  if (loaded.response) return loaded.response
  const { conversation } = loaded

  const { error } = await db.from('email_tickets')
    .update({ unread_count: 0 })
    .eq('id', conversation.id)
  if (error) {
    logError('email', 'mark read failed', { err: error, ticketId: conversation.id })
    return NextResponse.json({ success: false, error: 'Could not mark the conversation read.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { unread_count: 0 } })
})
