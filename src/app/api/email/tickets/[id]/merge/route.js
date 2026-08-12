// EMAIL-MERGE.4 — fold one ticket into another, reversibly.
//
// BOTH tickets go through loadTicketForUser. The gate lives there and not in
// this handler because a ticket's location is not knowable until the row is
// read (#1266); checking one ticket and trusting the other would let someone
// move mail out of a studio they cannot see. Every refusal is 404 — a 403 after
// the row is read is an existence oracle.
//
// REPARENTING IS THE POINT, NOT THE BOOKKEEPING. The inbound webhook threads
// replies via email_inbox_messages.ticket_id, so repointing that column is what
// makes the survivor the live thread; a merge that only stamped the pointer
// would send the correspondent's next reply back to the dead ticket.
//
// ORDER IS LOAD-BEARING. There is no cross-statement transaction here, so the
// writes are ordered to leave a finishable state if the process dies:
//   1. reparent the messages (idempotent — re-running matches nothing new)
//   2. update the target's counters
//   3. stamp the source tombstone LAST
// A crash before 3 leaves messages moved and the source still live but empty —
// visibly odd and fixed by re-running the merge. Stamping the tombstone first
// would instead hide a ticket whose messages never moved, which is silent loss.
//
// ATTACHMENTS AND QUOTA ARE DELIBERATELY UNTOUCHED. email_ticket_attachments
// keys on message_id, so attachments ride along with the rows that move — a
// second migration of them would be a second, divergent definition of where a
// file lives. And email_storage_usage was metered against the delivering
// mailbox when the bytes arrived; merging moves no bytes, so adjusting it would
// invent usage that never happened.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { canMerge, mergedTicketFields } from '@/lib/email-ticket-merge'
import { loadTicketForUser, ticketNotFound } from '../../_helpers'

// uuidLike, NOT z.string().uuid(): Stillorgan's seeded ids carry a version
// digit of 0, which Zod's RFC-strict .uuid() rejects and Postgres accepts.
const schema = z.object({ into: uuidLike })

const failed = (message) =>
  NextResponse.json({ success: false, error: message }, { status: 500 })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, schema)
  if (!validation.ok) return validation.response

  const db = createServerClient()

  // BOTH sides, both through the same gate, both before anything is written.
  const loadedSource = await loadTicketForUser(db, user, params.id)
  if (loadedSource.response) return loadedSource.response
  const loadedTarget = await loadTicketForUser(db, user, validation.data.into)
  if (loadedTarget.response) return loadedTarget.response

  const source = loadedSource.ticket
  const target = loadedTarget.ticket

  // Same-ticket, cross-location and already-merged all refuse here, and all
  // refuse as 404: the caller has already been told both ids exist by getting
  // past the loads, but the reason a merge is ineligible is still not something
  // this surface owes them, and a distinct code would be a new oracle to keep
  // in step with the four the loads already return.
  const eligible = canMerge(source, target)
  if (!eligible.ok) {
    // The caller gets nothing but 404; the REASON goes to the log, because on a
    // surface where four different refusals look identical, "merge just says
    // not found" is otherwise unanswerable from the outside. This is the only
    // consumer of the reason strings EMAIL-MERGE.3 pinned.
    console.error('[tickets/:id/merge] refused:', eligible.reason, source.id, '→', target.id)
    return ticketNotFound()
  }

  const now = new Date().toISOString()

  // 1. THE MESSAGES. Idempotent by construction: the filter is the source's own
  // ticket_id, which no longer matches once the rows have moved.
  const { error: moveError } = await db.from('email_inbox_messages')
    .update({ ticket_id: target.id, merged_from_ticket_id: source.id })
    .eq('ticket_id', source.id)
  if (moveError) {
    console.error('[tickets/:id/merge] reparent failed:', moveError.message)
    return failed('Could not move the messages. Nothing was merged — try again.')
  }

  // 2. THE SURVIVOR'S COUNTERS, from the pure resolver so the rules (summed
  // unread, the EARLIER first_response_at, the newer message's preview) live in
  // one testable place rather than in this handler's control flow.
  const { error: targetError } = await db.from('email_tickets')
    .update({ ...mergedTicketFields(source, target), updated_at: now })
    .eq('id', target.id)
  if (targetError) {
    console.error('[tickets/:id/merge] target update failed:', targetError.message)
    return failed('The messages moved but the surviving ticket did not update. Nothing was merged away — try again.')
  }

  // 3. THE TOMBSTONE, LAST. `closed` plus a pointer — never a fifth status
  // value. closed_at is preserved when the source already had one, the same
  // rule statusTimestamps applies (a ticket that was already closed genuinely
  // closed then, not now); solved_at is deliberately not written, because
  // merging is not a lifecycle transition. unread_count moves to the survivor,
  // so a hidden ticket cannot keep contributing to a badge nobody can clear.
  const { error: sourceError } = await db.from('email_tickets')
    .update({
      merged_into_id: target.id,
      merged_at: now,
      merged_by: user.id,
      status: 'closed',
      closed_at: source.closed_at || now,
      unread_count: 0,
      updated_at: now,
    })
    .eq('id', source.id)
  if (sourceError) {
    console.error('[tickets/:id/merge] tombstone failed:', sourceError.message)
    return failed('The messages moved but the old ticket is still open. Re-run the merge to finish it.')
  }

  return NextResponse.json({
    success: true,
    data: { ticket_id: source.id, merged_into_id: target.id },
  })
}

// DELETE — undo. The mirror image, and for the mirror reason: the messages go
// back FIRST and the pointer clears LAST. Clearing the pointer first and then
// failing would strand the stamped rows on the survivor with the tombstone
// already gone, and nothing left that looks for them; this way a failed undo
// leaves a tombstone that can simply be unmerged again.
export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  // Not a tombstone, nothing to undo — 404 like every other refusal here.
  if (!ticket.merged_into_id) return ticketNotFound()

  // EXACTLY the rows this merge moved, found by the stamp rather than by "every
  // message on the survivor". The survivor has its own correspondence, and on a
  // ticket that absorbed an earlier merge it has somebody else's too; keyed on
  // ticket_id, an undo would hand those to the wrong ticket.
  const { error: moveError } = await db.from('email_inbox_messages')
    .update({ ticket_id: ticket.id, merged_from_ticket_id: null })
    .eq('merged_from_ticket_id', ticket.id)
  if (moveError) {
    console.error('[tickets/:id/merge] unmerge move-back failed:', moveError.message)
    return failed('Could not move the messages back. Nothing was unmerged — try again.')
  }

  const { error: clearError } = await db.from('email_tickets')
    .update({
      merged_into_id: null,
      merged_at: null,
      merged_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticket.id)
  if (clearError) {
    console.error('[tickets/:id/merge] unmerge clear failed:', clearError.message)
    return failed('The messages moved back but the ticket is still marked merged. Try again.')
  }

  return NextResponse.json({ success: true, data: { ticket_id: ticket.id } })
}
