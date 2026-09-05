import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { loadTicketForUser, isNeedsReply, isArchived } from '../../_helpers'
import { loadOwnAddresses } from '../../../tickets/_helpers'
import { maybeNotifyInboundEmail } from '@/lib/email-inbound-push'
import { logError } from '@/lib/log'

const SpamSchema = z.object({
  // `true` quarantines, `false` releases. Two states, like archive.
  spam: z.boolean(),
})

// A support thread is a handful of messages; the bound is stated because every
// .select() caps at 1,000 rows whatever the caller asks for.
const MESSAGE_LIMIT = 500

// POST /api/email/mail/[id]/spam — Not spam / Mark as spam (MAIL-SPAM.1).
//
// THE FLAG IS ORTHOGONAL TO THE LIFECYCLE. `is_spam` (mig 584) sits beside
// `status`, never inside it: a quarantined conversation keeps whatever status
// the bump machinery gave it and is simply excluded from every view but Spam.
// So this route touches ONLY the spam columns — status, solved_at, closed_at
// and the archive verb are untouched in both directions.
//
// "NOT SPAM" RELEASES, AND FIRES WHAT INGEST SKIPPED. The webhook quarantines
// by suppressing exactly two things: the unread increment and the staff push
// (there is no auto-reply on this channel). Releasing owes the operator both,
// or a real member's email walks back into the inbox with no badge and no
// ping — the very silence the quarantine imposed, now on mail somebody has
// just said is real:
//   • unread_count is set to the number of UNSEEN inbound messages — the seen
//     route's own derivation, never an independent increment (two counters for
//     one fact is how a badge points at an empty list). Best-effort and logged:
//     losing the mirror costs a stale counter, and refusing the release over it
//     would cost the operator the thing they just did.
//   • maybeNotifyInboundEmail with the TICKET'S facts (requester, subject, the
//     last preview) and preUnreadCount 0 — this release IS the moment the
//     conversation becomes unseen. The fan-out's own gates (email_inbox at the
//     ticket's location, mailbox grant or elevated, own-address suppression)
//     apply unchanged; it never throws and never fails the request.
//
// "MARK AS SPAM" IS THE REVERSE, MINUS NOTIFICATIONS. Nobody is pinged about
// mail an operator has just said is junk. spam_flagged_at is set to NOW so the
// 30-day purge clock runs from the operator's decision, not from when the
// thread was born.
//
// IDEMPOTENT. A conversation already in the requested state is answered
// without a write and without a ping — the update also carries the transition
// filter (`.eq('is_spam', !spam)`) so two operators racing cannot both
// notify: PostgREST returns the rows it changed, and zero rows means the
// other click won.
//
// ALL THE GATES ARE loadTicketForUser's: location access, the `email_inbox`
// key at the TICKET's location, and the per-mailbox grant. Every refusal is
// the same 404.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SpamSchema)
  if (!validation.ok) return validation.response
  const { spam } = validation.data

  const db = createServerClient()
  const loaded = await loadTicketForUser(db, user, params.id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  // Already there — nothing to write, nobody to tell.
  if ((ticket.is_spam === true) === spam) {
    return NextResponse.json({ success: true, data: { conversation: shape(ticket), notified: false } })
  }

  const now = new Date().toISOString()
  const patch = spam
    ? { is_spam: true, spam_flagged_at: now, spam_verdict_source: 'operator', updated_at: now }
    : { is_spam: false, spam_flagged_at: null, spam_verdict_source: 'operator', updated_at: now }

  // `.select('*')` without .single(): the rows the UPDATE really changed are
  // the answer, and zero rows is a legitimate one (the race above).
  const { data: changed, error } = await db.from('email_tickets')
    .update(patch)
    .eq('id', ticket.id)
    .eq('is_spam', !spam)
    .select('*')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const updated = Array.isArray(changed) && changed[0] ? changed[0] : null
  if (!updated) {
    // Lost the race — somebody else already moved it. Report the state as it
    // stands (the other write's), and do not notify: the winner did.
    return NextResponse.json({
      success: true,
      data: { conversation: shape({ ...ticket, ...patch }), notified: false },
    })
  }

  let notified = false
  if (!spam) {
    notified = await releaseNotifications(db, updated)
  }

  return NextResponse.json({
    success: true,
    data: { conversation: shape(updated), notified },
  })
}

/** The same shape a list row carries, so the client can drop it straight in. */
function shape(row) {
  return {
    ...row,
    needs_reply: isNeedsReply(row),
    archived: isArchived(row),
  }
}

/**
 * What ingest owed and withheld: the unread mirror and the staff push. Both
 * best-effort, both logged, neither ever fails the release — the flag is
 * already cleared and the conversation is already back in the inbox.
 *
 * @returns {Promise<boolean>} whether the push fan-out was invoked
 */
async function releaseNotifications(db, ticket) {
  // ── unread mirror ──────────────────────────────────────────────────
  try {
    const { data: unseen, error: unseenErr } = await db.from('email_inbox_messages')
      .select('id')
      .eq('ticket_id', ticket.id)
      .eq('direction', 'inbound')
      .is('seen_at', null)
      .limit(MESSAGE_LIMIT)
    if (unseenErr) {
      logError('mail/spam', 'unread mirror read failed on release (conversation still released)', { ticketId: ticket.id, error: unseenErr })
    } else {
      const { error: mirrorErr } = await db.from('email_tickets')
        .update({ unread_count: (unseen || []).length })
        .eq('id', ticket.id)
        .select('id')
      if (mirrorErr) {
        logError('mail/spam', 'unread mirror write failed on release (conversation still released)', { ticketId: ticket.id, error: mirrorErr })
      }
    }
  } catch (err) {
    logError('mail/spam', 'unread mirror threw on release (conversation still released)', { ticketId: ticket.id, err })
  }

  // ── the push the webhook skipped ───────────────────────────────────
  // A compose-born thread nobody ever wrote back to has nothing to announce.
  if (ticket.has_inbound === false) return false
  try {
    // Own-address suppression, same list the reply/compose paths use. A failed
    // read degrades to "no suppression" rather than "no push": the requester
    // of a quarantined thread being one of our own mailboxes is essentially
    // impossible, and losing the ping is the worse outcome.
    const own = await loadOwnAddresses(db)
    const ownAddresses = own.addresses || []
    await maybeNotifyInboundEmail(db, {
      locationId: ticket.location_id,
      ticketId: ticket.id,
      ticketMailboxId: ticket.mailbox_id ?? null,
      fromEmail: ticket.requester_email,
      ownAddresses,
      requesterName: ticket.requester_name,
      subject: ticket.subject,
      preview: ticket.last_message_preview,
      // This release is the event that makes the conversation unseen.
      preUnreadCount: 0,
      assignedTo: ticket.assigned_to ?? null,
    })
    return true
  } catch (err) {
    logError('mail/spam', 'release push failed (conversation still released)', { ticketId: ticket.id, err })
    return false
  }
}
