// MAIL-TRIAL.B — the bridge from this surface's two verbs to the mailbox
// itself (`src/lib/mail/imap-writeback.js`, Phase A's file — call it, never
// edit it).
//
// 🔴 WHY THE PAIRING IS NOT OPTIONAL. `email_inbox_messages.seen_at` is a
// MIRROR of the IMAP \Seen flag, and the poller converges it in BOTH
// directions on a ~15-minute cadence. So a surface that writes the column
// alone does not mark anything read: it marks it read for a few minutes and
// then watches the sync quietly put it back, with the operator having no idea
// why the conversation they dealt with is bold again. Write both, or write
// neither. Archive is the same shape for a different reason — nothing
// converges it, but `status='closed'` on its own leaves the message sitting
// unread in the operator's real mailbox, which is the second triage this
// surface exists to remove.
//
// 🔴 WHY THIS FILE IS SEPARATE FROM _helpers.js. Importing it pulls in
// imapflow, and the LIST route has no business paying that cold start to show
// somebody their mail. Only the two mutation routes import this.
//
// ══ ONE MESSAGE PER CALL, AND THAT IS THE INTERESTING PART ═════════
// markSeen/archiveMessage each act on ONE message and each opens its own IMAP
// connection. A conversation is a thread, so the natural unit of this surface
// (mark this conversation read, archive this conversation) is inherently
// several messages.
//
// Two rules keep that honest, and both matter:
//   • SEQUENTIAL, never concurrent. Gmail caps SIMULTANEOUS connections per
//     account, and exceeding it locks the operator out of their own mailbox.
//     One at a time costs latency; in parallel it costs the mailbox.
//   • CAPPED. The set is only ever the messages the CRM write actually
//     changed — usually one, occasionally two or three — but "usually" is not
//     a bound, and an unbounded loop over a 40-message thread is 40 logins.
//     Past the cap the surface says what it did rather than doing it silently.
//
// There is deliberately NO batching built here. Batching is a change to Phase
// A's module, not something a caller should invent on top of it.

import { markSeen, markUnseen, archiveMessage } from '@/lib/mail/imap-writeback'

/**
 * How many messages one click may touch in the real mailbox.
 *
 * Five is a judgement, not a measurement: it covers every real support thread
 * (a member writing three times before anyone answers is already unusual) and
 * it bounds the worst case at five sequential logins rather than however many
 * messages a thread happens to hold.
 */
export const WRITEBACK_MAX_MESSAGES = 5

/**
 * Run one write-back over a conversation's messages, sequentially.
 *
 * WHAT COUNTS AS SUCCESS is not simply `ok`. `not_in_mailbox` means the
 * message is not in INBOX any more — already archived there, or moved by hand
 * — and the operator's intent is satisfied either way, so treating it as a
 * failure would put a red banner on the most ordinary outcome there is.
 * `no_message_reference` is its own answer again: a row with no
 * rfc_message_id cannot be matched back to the mailbox at all (nothing writes
 * an IMAP UID onto our message rows), and that is a gap in what we recorded
 * rather than something the mail server refused.
 *
 * @param {object} db  service-role client
 * @param {string} mailboxId
 * @param {string[]} rfcMessageIds  the messages the CRM write actually changed
 * @param {'seen'|'archive'} op
 * @returns {Promise<{attempted:number, applied:number, skipped:number,
 *                    unreferenced:number, noMailbox:boolean,
 *                    failures:Array<{reason:string,error:string}>}>}
 */
export async function applyWriteback(db, mailboxId, rfcMessageIds, op) {
  const all = Array.isArray(rfcMessageIds) ? rfcMessageIds : []
  const referenced = all.filter(id => typeof id === 'string' && id.trim())
  const targets = referenced.slice(0, WRITEBACK_MAX_MESSAGES)

  const result = {
    attempted: targets.length,
    applied: 0,
    skipped: referenced.length - targets.length,
    unreferenced: all.length - referenced.length,
    // 🔴 "THERE IS NO MAILBOX HALF" IS NOT "THE MAILBOX HALF FAILED".
    // A Postmark-fed account has no mail server behind it at all — the domain's
    // MX points at inbound.postmarkapp.com, so the message was never stored
    // anywhere this could reach. That is a permanent, correct, uninteresting
    // fact about the account, not something that went wrong with this click,
    // and it must not be reported as one. Counting it as a failure put
    // "there is no mailbox to change" under EVERY read and EVERY archive on
    // such an account — a true sentence rendered as an error, on the one
    // configuration where nothing could possibly have gone wrong.
    noMailbox: false,
    failures: [],
  }
  if (!mailboxId || targets.length === 0) return result

  // Three ops, one loop. Named rather than boolean so a fourth cannot be added
  // by flipping an argument at a call site.
  const write = op === 'archive' ? archiveMessage
    : op === 'unseen' ? markUnseen
      : markSeen
  for (const rfcMessageId of targets) {
    // Sequential on purpose — see the header. `await` inside a loop is the
    // point of this function, not an oversight: Promise.all here would open
    // every connection at once, which is the thing that locks an operator out
    // of their own Gmail. (No eslint-disable: `no-await-in-loop` is not on in
    // this repo, and a disable for a rule nobody runs is itself a lint error.)
    const verdict = await write(db, mailboxId, { rfcMessageId })
    if (verdict?.ok || verdict?.reason === 'not_in_mailbox') {
      result.applied += 1
      continue
    }
    // The answer is a property of the ACCOUNT, not of this message, so it is
    // identical for every target — stop rather than re-reading the mailbox row
    // once per message to be told the same thing.
    if (verdict?.reason === 'not_imap') {
      result.noMailbox = true
      break
    }
    result.failures.push({
      reason: verdict?.reason || 'write_failed',
      error: verdict?.error || 'The change could not be made in the mailbox.',
    })
  }
  return result
}

/**
 * The one sentence an operator is shown when the mailbox half did not land.
 *
 * 🔴 THE CRM HALF IS NOT ROLLED BACK, and this sentence is why it does not
 * have to be. Undoing the database write would cost the operator the action
 * they just took in order to report that half of it failed — trading a
 * divergence for a certain loss, which is the wrong direction every time. So
 * the write stands, and the surface says plainly which half is behind.
 *
 * The message is the write-back module's own operator-facing text, never the
 * mail server's words: a mailbox pointed at an internal host must report
 * exactly what an unreachable public one reports.
 *
 * Returns null when there is nothing to say, so a caller can spread it.
 */
export function writebackNotice(result, op) {
  if (!result) return null
  // Nothing to say: this account has no mail server behind it, so there is no
  // second half that could be behind. See applyWriteback's `noMailbox`.
  if (result.noMailbox) return null
  if (result.failures.length > 0) return result.failures[0].error
  if (result.skipped > 0) {
    // 🔴 THE TWO HALVES OF THIS SENTENCE ARE NOT SYMMETRIC, AND THE ARCHIVE ONE
    // HAS TO SAY MORE. Read state converges: the poller reconciles seen_at
    // against \Seen in both directions, so anything this skipped is picked up
    // within about fifteen minutes and the operator need do nothing. NOTHING
    // converges archive state — the skipped messages stay in the real INBOX for
    // good, and pressing the button again re-attempts the same newest slice
    // rather than reaching them. So the archive half names the remainder as
    // work the operator still has to do, in the mailbox, by hand. Telling them
    // only "the oldest were left" invites a second click that cannot help.
    if (op === 'archive') {
      return `This conversation is longer than ${WRITEBACK_MAX_MESSAGES} messages, so the oldest ones were left in the mailbox and will stay there — archive those in the mail app itself. It is archived here.`
    }
    return op === 'unseen'
      ? `This conversation is longer than ${WRITEBACK_MAX_MESSAGES} messages, so the oldest ones still show as read in the mailbox for now. They are unread here.`
      : `This conversation is longer than ${WRITEBACK_MAX_MESSAGES} messages, so the oldest ones are still unread in the mailbox for now. They are read here.`
  }
  if (result.unreferenced > 0) {
    return 'Part of this conversation could not be matched back to the mailbox, so it was left alone there.'
  }
  return null
}
