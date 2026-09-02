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
// ACCEPTED, AND DELIBERATE: re-running an interrupted merge adds the source's
// unread_count to the target a second time (mergedTicketFields sums, it does not
// reconcile), and a retried unmerge subtracts it twice. Both are a badge being
// wrong by a small number on a ticket somebody is already looking at, and both
// clear the instant it is opened — the alternative is a reconciliation table for
// a counter no report is derived from.
//
// ATTACHMENTS AND QUOTA ARE UNTOUCHED. email_ticket_attachments keys on
// message_id, so attachments ride along with the rows that move; a second
// migration of them would be a second, divergent definition of where a file
// lives. And email_storage_usage was metered against the delivering mailbox when
// the bytes arrived — merging moves no bytes, so adjusting it would invent usage
// that never happened.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logAuditEvent } from '@/lib/audit'
import { canMerge, mergedTicketFields, ticketFieldsFromMessages } from '@/lib/email-ticket-merge'
import { loadTicketForUser, ticketNotFound, PARTICIPANT_SCAN_LIMIT } from '../../_helpers'

// uuidLike, NOT z.string().uuid(): Stillorgan's seeded ids carry a version
// digit of 0, which Zod's RFC-strict .uuid() rejects and Postgres accepts.
const schema = z.object({ into: uuidLike })

// Everything ticketFieldsFromMessages reads. bodies are needed for the preview,
// so this is the one query on this route that is not trivially small — bounded
// by the same window the participant derivation uses.
const TRIO_COLUMNS = 'direction, text_body, subject, is_internal_note, forwarded_message_id, created_at'

const failed = (message) =>
  NextResponse.json({ success: false, error: message }, { status: 500 })

/**
 * Has either of these tickets already absorbed a merge?
 *
 * A SURVIVOR IS NOT A TOMBSTONE, which is the hole this closes. canMerge refuses
 * chains in the tombstone direction (a merged ticket can be neither source nor
 * target), but A→B leaves B perfectly mergeable, and B→C would then re-stamp A's
 * rows as having come from B — after which unmerging A restores nothing at all.
 * The headline promise of this feature is that a merge is exactly reversible, so
 * the answer is the same trade canMerge already makes: refuse the chain and keep
 * exactness by construction, rather than inventing multi-level provenance that
 * every future reader would have to hold in their head. Unmerge first, then
 * merge onward.
 *
 * It lives here rather than in canMerge because it needs a query, and that file
 * is pure so its refusals can be tested exhaustively.
 */
async function absorbedMerge(db, ticketIds) {
  const { data, error } = await db.from('email_inbox_messages')
    .select('ticket_id')
    .in('ticket_id', ticketIds)
    .not('merged_from_ticket_id', 'is', null)
    .limit(1)
  // A FAILED lookup is not "nothing absorbed" — the EMAIL-TICKET-CLEANUP.2
  // lesson. Read as an empty answer it would wave through exactly the merge
  // this check exists to refuse, and the damage is only visible later, at the
  // unmerge that then restores nothing.
  if (error) return { error }
  return { absorbedBy: data?.[0]?.ticket_id ?? null }
}

/** The messages on one ticket, newest first, for the trio derivation. */
function messagesOn(db, ticketId) {
  return db.from('email_inbox_messages')
    .select(TRIO_COLUMNS)
    .eq('ticket_id', ticketId)
    // Newest first, so the window can only ever truncate the OLD end: the
    // last-message trio — the queue's sort key and preview — is exact whatever
    // the thread length, and only first_response_at on a 500+ message thread
    // could be derived from a later answer than the true first.
    .order('created_at', { ascending: false })
    .limit(PARTICIPANT_SCAN_LIMIT)
}

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
  // CROSS-MAILBOX MERGE IS CURRENTLY PERMITTED, AND IT CHANGES WHO CAN READ THE
  // SOURCE'S MESSAGES. canMerge scopes to location_id, not to mailbox_id, so
  // folding accounts@ into studio@ is legal — and because mig 502 keys message
  // RLS on the TICKET'S mailbox, the billing correspondence becomes readable by
  // everyone holding a grant on the target's mailbox. Mig 502 exists precisely
  // because mailbox scoping was missing, so this re-widens a slice of what it
  // closed. Whether to refuse such merges or permit them with a warning is the
  // product owner's call and is OPEN — deliberately not decided here, and the
  // UI task will carry whichever answer comes back. Behaviour unchanged for now.
  const eligible = canMerge(source, target)
  if (!eligible.ok) {
    // The caller gets nothing but 404; the REASON goes to the log, because on a
    // surface where four different refusals look identical, "merge just says
    // not found" is otherwise unanswerable from the outside. This is the only
    // consumer of the reason strings EMAIL-MERGE.3 pinned.
    console.error('[tickets/:id/merge] refused:', eligible.reason, source.id, '→', target.id)
    return ticketNotFound()
  }

  const absorbed = await absorbedMerge(db, [source.id, target.id])
  if (absorbed.error) {
    console.error('[tickets/:id/merge] absorbed-merge check failed:', absorbed.error.message)
    return failed('Could not check whether these tickets have been merged before. Nothing was changed — try again.')
  }
  if (absorbed.absorbedBy) {
    console.error('[tickets/:id/merge] refused: already_absorbed_a_merge', absorbed.absorbedBy)
    return ticketNotFound()
  }

  const now = new Date().toISOString()

  // 1. THE MESSAGES. Idempotent by construction: the filter is the source's own
  // ticket_id, which no longer matches once the rows have moved.
  // `.select('id')` so the audit event below can say HOW MANY moved — the one
  // number that makes a merge reconstructable after the fact.
  const { data: moved, error: moveError } = await db.from('email_inbox_messages')
    .update({ ticket_id: target.id, merged_from_ticket_id: source.id })
    .eq('ticket_id', source.id)
    .select('id')
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
  // value. closed_at is preserved when the source already had one, the same rule
  // statusTimestamps applies (a ticket that was already closed genuinely closed
  // then, not now); solved_at is deliberately not written, because merging is
  // not a lifecycle transition.
  //
  // unread_count IS DELIBERATELY LEFT ALONE, and this is load-bearing for the
  // undo. It is a counter — incremented per inbound by
  // increment_email_ticket_unread, zeroed by …/read — so it is NOT derivable
  // from the message rows, and zeroing it here would destroy the only record of
  // what the survivor absorbed, making unmerge unable to give it back. On the
  // tombstone it is inert: scopeToUnmerged hides merged tickets from the list
  // and the badge, and nothing anywhere sums this column.
  //
  // CONDITIONAL ON THE SOURCE NOT ALREADY BEING MERGED, and PGRST116 (no row
  // matched) is the refusal — the shape the assign route's claim race uses. Two
  // operators merging the same ticket into DIFFERENT targets would otherwise
  // both stamp it: the pointer would name one survivor while the messages sat
  // split across two, and the undo would restore half a conversation.
  //
  // THE RACE THIS CONDITION CANNOT CATCH, AND WHY THAT IS ACCEPTED. Two
  // operators merging the same PAIR in OPPOSITE directions at the same moment
  // (A→B and B→A) both succeed: each stamps a DIFFERENT row, so each finds its
  // own source's merged_into_id still null and the condition holds for both.
  // The result is two tombstones pointing at each other, and since
  // scopeToUnmerged hides both, the conversation disappears from every list and
  // count. No PostgREST condition can close it — the guard would have to assert
  // something about the OTHER ticket in the same statement, which only a DB
  // trigger (or a real transaction) could do.
  //
  // Accepted rather than fixed, deliberately: it needs two operators merging
  // the same pair, in opposite directions, inside the few milliseconds between
  // one request's absorbed-merge read and its stamp — and this is a
  // single-operator system today. It is also fully recoverable without a
  // migration: DELETE on EITHER tombstone unmerges that side and brings the
  // conversation back. If a second concurrent operator ever becomes normal,
  // the fix is a BEFORE UPDATE trigger on email_tickets refusing a stamp whose
  // target is itself already a tombstone, not more client-side conditions.
  const { error: sourceError } = await db.from('email_tickets')
    .update({
      merged_into_id: target.id,
      merged_at: now,
      merged_by: user.id,
      status: 'closed',
      closed_at: source.closed_at || now,
      updated_at: now,
    })
    .eq('id', source.id)
    .is('merged_into_id', null)
    .select('id')
    .single()
  if (sourceError?.code === 'PGRST116') {
    console.error('[tickets/:id/merge] lost the race — already merged elsewhere:', source.id)
    return NextResponse.json({
      success: false,
      error: 'Somebody else merged this ticket while you were looking at it. Reload to see where its messages went.',
    }, { status: 409 })
  }
  if (sourceError) {
    console.error('[tickets/:id/merge] tombstone failed:', sourceError.message)
    return failed('The messages moved but the old ticket is still open. Re-run the merge to finish it.')
  }

  // Moving a member's correspondence from one ticket to another is the most
  // audit-worthy act on this surface — more so than the sends, which at least
  // leave a message row behind. BOTH ids and the count go in the details,
  // because after an unmerge the ticket rows themselves say nothing: DELETE
  // nulls merged_by, so without this the fact a conversation was moved at all
  // would survive nowhere. logAuditEvent never throws and the merge has already
  // happened either way, exactly as the compose/reply/forward calls are built.
  await logAuditEvent({
    category: 'business',
    action: 'email_ticket.merged',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `email_ticket/${source.id}`, label: source.subject || null },
    locationId: source.location_id,
    details: {
      merged_into_id: target.id,
      merged_into_subject: target.subject || null,
      message_count: (moved || []).length,
    },
    request,
  })

  return NextResponse.json({
    success: true,
    data: { ticket_id: source.id, merged_into_id: target.id },
  })
}

// DELETE — undo, and a real one: both tickets come back as they were.
//
// The messages go back FIRST and the pointer clears LAST, for the mirror of the
// merge's reason. Clearing the pointer first and then failing would strand the
// stamped rows on the survivor with the tombstone already gone, and nothing left
// that looks for them; this way a failed undo leaves a tombstone that can simply
// be unmerged again.
//
// BOTH TICKETS ARE RECOMPUTED FROM THE ROWS THAT NOW EXIST. Moving the messages
// is not enough on its own: the survivor keeps advertising a last message that
// has left it (wrong preview in the queue, and a sort key it does not own) and a
// first_response_at it may never have earned. The one field that cannot be
// derived from rows is unread_count — a counter, not a property of the messages
// — so it is reversed arithmetically against the tombstone's own retained count,
// which is exactly why the merge does not zero it.
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
  const targetId = ticket.merged_into_id

  // THE SURVIVOR GOES THROUGH THE SAME GATE AS THE MERGE PUT IT THROUGH. This
  // route takes messages OFF that ticket and rewrites its counters, so gating
  // only the tombstone would leave the pair asymmetric — and asymmetric gating
  // on two operations that mirror each other is how the next reader concludes
  // the looser one is the intended pattern.
  const loadedTarget = await loadTicketForUser(db, user, targetId)
  if (loadedTarget.response) return loadedTarget.response
  const target = loadedTarget.ticket

  // EXACTLY the rows this merge moved, found by the stamp rather than by "every
  // message on the survivor". The survivor has its own correspondence, and
  // keyed on ticket_id an undo would hand that to the wrong ticket.
  // `.select('id')` for the audit count, as on the way in.
  const { data: movedBack, error: moveError } = await db.from('email_inbox_messages')
    .update({ ticket_id: ticket.id, merged_from_ticket_id: null })
    .eq('merged_from_ticket_id', ticket.id)
    .select('id')
  if (moveError) {
    console.error('[tickets/:id/merge] unmerge move-back failed:', moveError.message)
    return failed('Could not move the messages back. Nothing was unmerged — try again.')
  }

  const [targetMessages, sourceMessages] = await Promise.all([
    messagesOn(db, targetId),
    messagesOn(db, ticket.id),
  ])
  // A failed read here is not an empty thread: acting on one would blank both
  // tickets' previews and null their sort keys — the same silent-wrong-answer
  // shape EMAIL-TICKET.6 fixed for the thread view. The rows are already back
  // where they belong, so refusing costs a retry and nothing else.
  if (targetMessages.error || sourceMessages.error) {
    console.error(
      '[tickets/:id/merge] unmerge rebuild read failed:',
      targetMessages.error?.message || sourceMessages.error?.message
    )
    return failed('The messages moved back but the ticket totals could not be rebuilt. Try again.')
  }

  // The survivor gives back exactly what it took — the tombstone's own retained
  // count. Clamped at zero, because somebody may have opened the survivor since
  // the merge and cleared the badge; subtracting into the negative would then
  // invent headroom on the next inbound.
  // MAIL-SENT.1 — has_inbound is recomputed EXACTLY, not from the bounded
  // message window above (newest-first, so a windowed derivation could
  // "prove" absence on a long thread and silently bounce a real Inbox
  // conversation to Sent). Two head-counts answer presence outright; a
  // failed count leaves the column untouched — wrongly-in-Inbox is the
  // visible direction, wrongly-in-Sent is the buried one.
  const hasInboundOf = async (ticketId) => {
    const { count, error } = await db.from('email_inbox_messages')
      .select('*', { count: 'exact', head: true })
      .eq('ticket_id', ticketId)
      .eq('direction', 'inbound')
      .eq('is_internal_note', false)
    if (error) {
      console.error('[tickets/:id/merge] has_inbound recount failed:', error.message)
      return null
    }
    return (count || 0) > 0
  }
  const [targetHasInbound, sourceHasInbound] = await Promise.all([
    hasInboundOf(targetId),
    hasInboundOf(ticket.id),
  ])

  const { error: targetError } = await db.from('email_tickets')
    .update({
      ...ticketFieldsFromMessages(targetMessages.data),
      ...(targetHasInbound === null ? {} : { has_inbound: targetHasInbound }),
      unread_count: Math.max(0, (target.unread_count || 0) - (ticket.unread_count || 0)),
      updated_at: new Date().toISOString(),
    })
    .eq('id', targetId)
  if (targetError) {
    console.error('[tickets/:id/merge] unmerge target rebuild failed:', targetError.message)
    return failed('The messages moved back but the surviving ticket was not rebuilt. Try again.')
  }

  // LAST, with the pointer. The source's own trio was never overwritten by the
  // merge, so recomputing it is a no-op on a healthy row — and self-healing on
  // one that drifted.
  const { error: clearError } = await db.from('email_tickets')
    .update({
      ...ticketFieldsFromMessages(sourceMessages.data),
      ...(sourceHasInbound === null ? {} : { has_inbound: sourceHasInbound }),
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

  // The undo is logged for the same reason the merge is, and MORE urgently:
  // this write nulls merged_into_id / merged_at / merged_by, so the moment it
  // lands the ticket rows carry no trace that the correspondence was ever moved.
  // This event is the only surviving record of the second move.
  await logAuditEvent({
    category: 'business',
    action: 'email_ticket.unmerged',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { resource: `email_ticket/${ticket.id}`, label: ticket.subject || null },
    locationId: ticket.location_id,
    details: {
      unmerged_from_id: targetId,
      unmerged_from_subject: target.subject || null,
      message_count: (movedBack || []).length,
    },
    request,
  })

  return NextResponse.json({ success: true, data: { ticket_id: ticket.id, unmerged_from: targetId } })
}
