import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { loadTicketForUser, assertInboxSurface } from '../../_helpers'
import { applyWriteback, writebackNotice } from '../../_writeback'

const SeenSchema = z.object({
  // Both directions, and BOTH ARE PAIRED WRITES. `false` was refused here at
  // first, on the correct reasoning that a CRM-only unread mark undoes itself
  // — the fix for that was markUnseen() in the write-back module, which now
  // exists, not a permanently missing verb. See the header.
  seen: z.boolean(),
})

// POST /api/email/mail/[id]/seen — mark one conversation read (MAIL-TRIAL.B).
//
// READ STATE LIVES ON THE MESSAGES (`email_inbox_messages.seen_at`, mig 575),
// not on a counter on the conversation, because the column is a MIRROR of the
// IMAP \Seen flag. That is the whole point of it: mail the operator reads in
// their own mail client shows as read here, and mail they read here shows as
// read there. A counter maintained only by our inbound webhook could never do
// either.
//
// 🔴 SO THE WRITE IS PAIRED, ALWAYS. The poller converges seen_at against the
// mailbox in BOTH directions on a ~15-minute cadence, so writing the column
// alone does not mark anything read — it marks it read for a few minutes and
// then lets the sync put it back, with nothing on screen to explain why. Both
// halves, or neither.
//
// MARK UNREAD IS THE SAME DEAL, IN THE OTHER DIRECTION. It shipped disabled at
// first because imap-writeback.js had no markUnseen(), and a CRM-only unread
// mark is converged away within a quarter of an hour — a button that silently
// undoes itself being worse than a missing one. That was right about the
// danger and wrong about the remedy: the mail surface would have entered the
// trial with NO defer verb while the ticket queue has reopen, which biases the
// very comparison the trial exists to settle. So markUnseen() was added and
// this route pairs it exactly as it pairs the read direction.
//
// Clearing \Seen destroys nothing and moves nothing — the worst case is one
// email going bold again in head office's Gmail, which reading it undoes.
//
// ONLY INBOUND MESSAGES CAN BE READ OR UNREAD. Our own sent replies are not
// something to read, and stamping them would make "unread" mean "recent".
//
// email_tickets.unread_count IS KEPT IN AGREEMENT, derived from exactly the
// rows this route wrote rather than incremented independently — two counters
// for one fact is how a badge ends up pointing at an empty list. Its write is
// best-effort and logged: losing the mirror costs a stale badge on a screen
// nobody uses for this mailbox, and refusing the request over it would cost
// the operator the read state they asked for.
//
// ALL FOUR GATES: loadTicketForUser carries location access, the `email_inbox`
// key at the TICKET's location and the per-mailbox grant; assertInboxSurface
// adds this screen's own. Every refusal is the same 404. The write-back module
// then re-reads the mailbox row and applies the surface guard AGAIN at the
// source, which is not redundant — it is what stops a future caller mutating a
// ticketing mailbox by handing over a stale row.

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SeenSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const onSurface = await assertInboxSurface(db, ticket.mailbox_id)
  if (onSurface.response) return onSurface.response

  const { seen } = validation.data
  const now = new Date().toISOString()
  // `.select()` so the rows the UPDATE really touched are knowable — a
  // zero-row UPDATE is not an error in PostgREST, and both the write-back set
  // and the count below are derived from what changed rather than from what we
  // hoped would. `.is('seen_at', null)` is what makes re-opening a
  // conversation a no-op rather than a rewrite of when it was first read.
  // The transition guard mirrors the direction: marking read touches only the
  // unread rows, marking unread only the read ones. Either way the returned
  // set is exactly what changed, so the mailbox half acts on that and nothing
  // else — re-pressing the button is a no-op rather than a second IMAP write.
  const patch = seen ? { seen_at: now } : { seen_at: null }
  let update = db.from('email_inbox_messages')
    .update(patch)
    .eq('ticket_id', ticket.id)
    .eq('direction', 'inbound')
  update = seen ? update.is('seen_at', null) : update.not('seen_at', 'is', null)
  const { data: changed, error } = await update.select('id, rfc_message_id')
  // 🔴 NO .limit() ON THIS UPDATE. PostgREST refuses a limited mutation that
  // carries no explicit order (PGRST124), so a bound added here "for safety"
  // would turn every read mark into a 400 in production while passing every
  // test against the fake. The set is naturally small — it is the unread
  // inbound messages of ONE conversation — and the returned representation is
  // capped at 1,000 rows by PostgREST regardless.
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const rows = changed || []

  // The mailbox half. Only the messages this write actually changed — usually
  // one — so the common case is a single connection.
  const writeback = await applyWriteback(
    db, ticket.mailbox_id, rows.map(r => r.rfc_message_id), seen ? 'seen' : 'unseen'
  )

  // Derived from the rows this route actually changed, never incremented
  // independently — two counters for one fact is how a badge ends up pointing
  // at an empty list.
  const { error: mirrorErr } = await db.from('email_tickets')
    .update({ unread_count: seen ? 0 : rows.length })
    .eq('id', ticket.id)
    .select('id')
  // Logged, never surfaced and never failed on — see the header.
  if (mirrorErr) {
    console.error('[email/mail] unread_count mirror failed for ticket', ticket.id, mirrorErr.message)
  }

  return NextResponse.json({
    success: true,
    data: {
      id: ticket.id,
      unread: seen ? 0 : rows.length,
      changed: rows.length,
      // The action SUCCEEDED — it is recorded here and the conversation is
      // read on this screen. The notice says the mailbox half is behind, which
      // is a different sentence from "that did not work" and must not be
      // rendered as one.
      writeback_notice: writebackNotice(writeback, 'seen'),
    },
  })
}
