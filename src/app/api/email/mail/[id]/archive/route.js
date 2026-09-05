import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  loadTicketForUser, statusTimestamps, stampMailRow,
} from '../../_helpers'
import { applyWriteback, writebackNotice } from '../../_writeback'

// A support thread is a handful of messages; the bound is stated because every
// .select() caps at 1,000 rows whatever the caller asks for.
const MESSAGE_LIMIT = 500

const ArchiveSchema = z.object({
  // Two states, not four. `true` files it away, `false` brings it back.
  archived: z.boolean(),
})

// POST /api/email/mail/[id]/archive — the Mail surface's primary verb
// (MAIL-TRIAL.B).
//
// ARCHIVE IS `status='closed'`. It is not a new column and there is no second
// lifecycle: one set of states on disk, two vocabularies on screen. A second
// lifecycle would drift from the first within a release, and the two surfaces
// share every row.
//
// UNARCHIVING RESTORES `open`, NOT `pending`. `open` is the honest answer:
// whether the conversation then reads as needing a reply is decided by
// last_message_direction, which is a fact about the correspondence rather than
// something this route gets to assert. Restoring `pending` would silently
// claim we had already answered.
//
// WHY THIS IS NOT A CALL TO /api/email/tickets/[id]/status:
//   • that route accepts all four lifecycle values, and this surface must be
//     structurally incapable of producing the other two — an inbox that can
//     write `solved` has grown the ceremony it exists to drop;
//   • it has no surface guard, so it would happily archive a TICKETING
//     mailbox's ticket from the mail screen;
//   • it is the archive verb that the IMAP write-back hangs off (see below).
// Everything it actually does is still shared: loadTicketForUser is the gate,
// statusTimestamps is the stamp logic, both imported rather than restated.
//
// 🔴 ARCHIVING IS A PAIRED WRITE: `status='closed'` here AND a move to the
// provider's Archive folder there (imap-writeback.js's archiveMessage, Phase
// A's file). The database half alone would leave the message sitting unread in
// the operator's real mailbox, which is the second triage this whole surface
// exists to remove — a CRM that mirrors mail and files it away only for itself
// is a mirror with an Archive button that lies.
//
// 🔴 BRINGING ONE BACK IS **NOT** PAIRED, AND CANNOT BE. The write-back module
// has two operations and no third: there is no move-out-of-Archive. So
// un-archiving restores the conversation on this screen and leaves the message
// where it is in the mailbox. That divergence is stable rather than silent —
// nothing converges archive state the way the \Seen mirror converges read
// state — but it is a real limit of the trial and it is stated here so nobody
// discovers it by noticing Gmail disagreeing.
//
// THE MAILBOX HALF NEVER FAILS THE REQUEST. The archive IS recorded here, and
// a write-back that could not land is reported as a notice beside a successful
// action rather than as a failure of it: rolling the row back would cost the
// operator the thing they just did in order to tell them half of it did not
// happen, which is trading a divergence for a certain loss.
//
// ALL THREE GATES: loadTicketForUser carries the location access, the
// `email_inbox` key resolved at the TICKET's location, and the per-mailbox
// grant. Every refusal is the same 404, so an id cannot be probed.
// (RETIRE-TICKETS.1 removed the fourth, surface, gate along with the surface
// itself — mig 578. Orphans archive here now: the DB half applies and
// applyWriteback short-circuits on the null mailbox.)
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ArchiveSchema)
  if (!validation.ok) return validation.response
  const { archived } = validation.data

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const status = archived ? 'closed' : 'open'
  const now = new Date().toISOString()
  const { data: updated, error } = await db.from('email_tickets')
    .update({ status, updated_at: now, ...statusTimestamps(status, ticket, now) })
    .eq('id', ticket.id)
    .select('*')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // The mailbox half — only on the way IN, and only over the INBOUND messages:
  // an outbound reply lives in Sent, not INBOX, so there is nothing there to
  // move. Read after the status write, so a conversation that failed to
  // archive here is never moved there.
  let writeback = null
  if (archived) {
    const { data: inbound, error: inboundErr } = await db.from('email_inbox_messages')
      .select('id, rfc_message_id')
      .eq('ticket_id', ticket.id)
      .eq('direction', 'inbound')
      // 🔴 NEWEST FIRST, AND THE ORDER IS LOAD-BEARING. applyWriteback moves at
      // most WRITEBACK_MAX_MESSAGES of these, so on a longer conversation this
      // query DECIDES which messages stay in the real INBOX. Unordered,
      // PostgREST returns rows in whatever order it likes (in practice
      // insertion order), which meant the messages left behind were the most
      // RECENT ones — the ones sitting at the top of head office's Gmail, i.e.
      // the worst possible ones to leave — while the notice told the operator
      // the opposite, that "the oldest ones were left". Newest-first moves the
      // visible ones and strands the buried ones, which is the least-bad half
      // to leave AND makes that sentence true.
      .order('created_at', { ascending: false })
      .limit(MESSAGE_LIMIT)
    if (inboundErr) {
      // The archive stands; we simply could not work out what to move. Said as
      // a notice for the same reason a failed write-back is.
      console.error('[email/mail] could not read messages to archive in the mailbox:', inboundErr.message)
      writeback = { attempted: 0, applied: 0, skipped: 0, unreferenced: 1, failures: [] }
    } else {
      writeback = await applyWriteback(
        db, ticket.mailbox_id, (inbound || []).map(m => m.rfc_message_id), 'archive'
      )
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      // The same shape a list row carries (the list's own stamp helper), so the
      // client can drop it straight in rather than re-deriving two predicates
      // it was told once already.
      conversation: stampMailRow(updated),
      // A note beside a SUCCESSFUL action, never an error in disguise.
      writeback_notice: writebackNotice(writeback, 'archive'),
    },
  })
}
