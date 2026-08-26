// MAILBOX-SENT.1 — the Sent-folder writer.
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §5
// Phase 8A. Migration: 574 (the idempotency index this file leans on entirely).
//
// WHY THIS FILE EXISTS
// A connected mailbox is a REAL mailbox that people still open. Head office
// reads hatchstreet@un1t.com in Gmail; a coach answers from their phone. A
// reply sent that way lands in the account's Sent folder and never touches
// INBOX, so the INBOX-only poller never sees it: the ticket sits "needs reply"
// forever and the next person to look answers the member a second time. Of the
// three mail-client divergences in §5's table that is the only customer-facing
// one, and it is the last gap in the R2 release.
//
// 🔴 WHY THIS IS NOT A PRODUCER LIKE EVERY OTHER INGRESS
// Every other way mail enters this CRM POSTs a Postmark-shaped payload at the
// untouched inbound webhook, and Phase 3 went to real trouble to keep it that
// way (see imap-message.js's header). That pattern CANNOT carry us here:
// processInboundEmail writes `direction: 'inbound'` throughout, and a reply a
// colleague sent from Gmail is OUTBOUND. Reusing the webhook would file our own
// answers as if the member had written them — new tickets, unread badges,
// push notifications, all of it backwards. So this lane gets its own writer.
// It is the one deliberate exception in the design, called out in §5, and it is
// why coexistence is its own phase rather than a flag on the poller.
//
// What it is NOT is a second parser. `payload` is the same Postmark-shaped
// object toInboundPayload() produces for the inbox lane, and every field is
// read with the same helpers the webhook uses (extractCandidateMessageIds,
// extractRfcMessageId, inboundAddresses, htmlToPlainText, truncateHtmlBody,
// sanitizeDbText). Only the WRITE differs, because only the write is different.
//
// ── DEDUPE: ONE MECHANISM, TWO JOBS ──────────────────────────────────
// There is no "is this ours?" comparison in this file and there must not be
// one. Mig 574's UNIQUE (ticket_id, rfc_message_id) does both jobs:
//   • re-polling Sent cannot double-file the same reply onto the same ticket
//     (the poller's cursor only advances on a handled message, so a tick that
//     dies mid-message is DESIGNED to re-deliver it); and
//   • OUR OWN SMTP sends land in the same Sent folder, and the reply route
//     already wrote an outbound row on that ticket carrying that
//     rfc_message_id at send time (MAILBOX-CONNECT.7) — so our own copy hits
//     23505 here and is skipped.
// Two predicates would eventually disagree; one index cannot.
//
// 🔴 That index is SCOPED PER TICKET, never global on rfc_message_id — read
// mig 574's comment before touching it. The connector deliberately files one
// copy per connected mailbox when two are on the same thread, so one RFC id
// legitimately lands on two tickets.
//
// 🔴 AND IT ONLY WORKS IF rfc_message_id IS STORED BARE. The whole threading
// chain is plain string equality: '<a@b>' matches nothing that 'a@b' matches.
// That exact bug shipped once already in the send path, which is why every id
// here goes through extractRfcMessageId() (brackets stripped) and never
// through a raw header value.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────
//   • It NEVER creates a ticket. See fileClientSentReply's orphan branch.
//   • It NEVER calls src/lib/email-inbound-push.js. Telling staff "new mail"
//     because a colleague answered is the exact opposite of the point of this
//     phase. There is no import of it in this file, on purpose.
//   • It NEVER increments unread_count and NEVER changes status. A staff reply
//     is not a member reply: a closed ticket stays closed (contrast the inbound
//     rule, where a member's reply reopens), and unread is a per-user counter
//     about mail somebody owes an answer to.
//   • It NEVER throws. Every fault is a returned verdict — supabase builders
//     are thenables that RESOLVE with { data, error }, so a wrapping try/catch
//     cannot see a failed write, and a discarded error is a lint-gated class
//     (CLAUDE.md). The caller decides what to do with ok:false; what it must
//     not do is advance its cursor.
//
// ── THE CONTRACT WITH THE POLLER (Phase 8B) ──────────────────────────
//   { ok: true,  outcome: 'filed',     ticketId, messageId }
//   { ok: true,  outcome: 'duplicate', ticketId }   // 23505 — already filed, or OURS
//   { ok: true,  outcome: 'orphan' }                // no thread we hold
//   { ok: false, reason, error }                    // a real fault
// All three ok:true outcomes count as HANDLED and the cursor may advance past
// them. ok:false must hold the watermark.

import { sanitizeDbText } from '../db-safe-text'
import { htmlToPlainText } from '../email-content'
import {
  extractCandidateMessageIds,
  extractRfcMessageId,
  getHeader,
  inboundPreview,
  normalizeEmail,
  parseEmailDate,
  truncateHtmlBody,
} from '../email-inbox'
import { inboundAddresses } from '../email-recipients'
import { pickThreadedTicket, shouldStampFirstResponse } from '../email-tickets'
import { logError, logWarn } from '../log'

/**
 * `email_inbox_messages.source` for a reply sent from the operator's own mail
 * client. A NEW value in a column that has no CHECK (the vocabulary is free —
 * 'operator' is what the CRM's own reply routes write).
 *
 * It is what lets the thread, and any later reporting, tell "answered from
 * Gmail" from "answered in the CRM" — the two are the same fact for the member
 * and different facts for an operator looking at how their studio works.
 * Exported so Phase 8C's renderers key off this constant rather than a fifth
 * copy of the string literal.
 */
export const MAIL_CLIENT_SOURCE = 'mail_client'

/**
 * Chunk the .in() candidate list defensively — a References chain on a long
 * thread can be hundreds of ids. Same cap, same reason, as the inbound webhook.
 */
const MAX_THREAD_CANDIDATES = 40

/**
 * App-clock vs DB-clock tolerance when deciding whether this message is really
 * the ticket's newest. Same constant and same purpose as the inbound webhook's
 * finish-up bump.
 */
const BUMP_SKEW_MS = 2_000

/** The ticket columns this writer needs, and no more. */
const TICKET_COLUMNS = 'id, location_id, contact_id, status, last_message_at, first_response_at'

/**
 * File a reply somebody sent from their own mail client as an OUTBOUND message
 * on the ticket it belongs to.
 *
 * @param {object} db  the service-role supabase client
 * @param {object} args
 * @param {object} args.mailbox  the email_mailboxes row being polled —
 *   `location_id` is load-bearing (it scopes the threading lookup), `address`
 *   becomes from_email, `id` is for the logs.
 * @param {object} [args.msg]  the raw IMAP message, for its uid in the logs.
 *   Nothing is read off it that changes what is written.
 * @param {object} args.payload  the Postmark-shaped object toInboundPayload()
 *   produced for this message.
 * @returns {Promise<object>} a verdict; see the contract in the file header.
 */
export async function fileClientSentReply(db, { mailbox, msg, payload } = {}) {
  try {
    return await fileSent(db, { mailbox, msg, payload })
  } catch (err) {
    // Belt-and-braces on a function whose every fault is already a return
    // value. A bug in ours must not become an exception the poller's own
    // per-message isolation has to guess at.
    logError('sent-lane', 'filing a mail-client reply threw', {
      mailboxId: mailbox?.id, uid: msg?.uid, err,
    })
    return { ok: false, reason: 'unexpected', error: err }
  }
}

async function fileSent(db, { mailbox, msg, payload }) {
  const uid = Number.isFinite(msg?.uid) ? msg.uid : null
  const mailboxId = mailbox?.id ?? null

  // 🔴 THE SCOPE, AND THE ONLY INPUT THIS FUNCTION REFUSES TO PROCEED WITHOUT.
  // Every threading query below is filtered by it. An RFC Message-ID is
  // guessable text in a header anyone can write, so without the scope a crafted
  // References chain in a message dropped into a connected Sent folder could
  // thread onto another studio's ticket — the cross-studio mixing the mailbox
  // routing exists to prevent. Failing here cannot wedge a real lane: the
  // poller reads location_id off the same row it reads the credentials from.
  const locationId = mailbox?.location_id ?? null
  if (!locationId || !payload || typeof payload !== 'object') {
    logError('sent-lane', 'refusing to file — no mailbox location or no payload', { mailboxId, uid })
    return { ok: false, reason: 'invalid_input', error: new Error('mailbox.location_id and payload are required') }
  }

  const headers = Array.isArray(payload.Headers) ? payload.Headers : []
  const subject = sanitizeDbText(payload.Subject) || null

  // ── Which ticket does this join? ─────────────────────────────────
  // In-Reply-To first, then References newest→oldest — exactly the candidate
  // list the inbound webhook builds, because a client-sent reply carries the
  // same headers a member's reply does. sanitizeDbText on each: a NUL inside a
  // threading header would otherwise ride into the .in() filters and can fail
  // the SELECT itself (EMAIL-INBOUND-POISON.1).
  const candidates = extractCandidateMessageIds(headers)
    .map(sanitizeDbText)
    .filter(Boolean)
    .slice(0, MAX_THREAD_CANDIDATES)

  let ticketId = null
  if (candidates.length) {
    // TWO `.in()` QUERIES RATHER THAN ONE `.or()`, and that is not a style
    // choice: `.or()` takes a RAW PostgREST filter string, so a stray `)` in a
    // References header would rewrite the filter. `.in()` is escaped by
    // postgrest-js. Mirrors the inbound webhook, deliberately.
    //
    // Both ids are searched because both are threading anchors we hold:
    // rfc_message_id is what an inbound message's own Message-ID was stored as,
    // and postmark_message_id is what our Postmark-era sends were keyed on.
    const [byRfc, byPostmark] = await Promise.all([
      db.from('email_inbox_messages')
        .select('ticket_id, created_at')
        .eq('location_id', locationId)
        .not('ticket_id', 'is', null)
        .in('rfc_message_id', candidates),
      db.from('email_inbox_messages')
        .select('ticket_id, created_at')
        .eq('location_id', locationId)
        .not('ticket_id', 'is', null)
        .in('postmark_message_id', candidates),
    ])
    const threadErr = byRfc.error || byPostmark.error
    if (threadErr) {
      logError('sent-lane', 'threading lookup failed', { mailboxId, uid, err: threadErr })
      return { ok: false, reason: 'thread_lookup_failed', error: threadErr }
    }
    ticketId = pickThreadedTicket([...(byRfc.data || []), ...(byPostmark.data || [])])
  }

  if (!ticketId) {
    // 🔴 ORPHAN — AND NO TICKET IS CREATED. A Sent message with no ingested
    // thread is almost always a conversation that predates the connection, or
    // one the operator started somewhere else entirely. Conjuring a ticket for
    // it would produce one with no inbound message, no requester and no
    // contact: noise an operator has to clear, in the queue this feature exists
    // to make trustworthy. A warn line naming the mailbox and the subject is
    // the whole handling, and it is enough — 'orphan' is a HANDLED outcome, so
    // the poller steps past it and the message is simply not our business.
    logWarn('sent-lane', 'sent message threads to no ticket we hold — not filed, no ticket created', {
      mailboxId, uid, subject,
    })
    return { ok: true, outcome: 'orphan' }
  }

  // Re-read the ticket rather than trusting the thread lookup's ticket_id:
  // it gives the location check a second, direct assertion, and it is where the
  // bump guard and the first-response stamp read their inputs from.
  const { data: ticket, error: ticketErr } = await db.from('email_tickets')
    .select(TICKET_COLUMNS)
    .eq('id', ticketId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (ticketErr) {
    logError('sent-lane', 'ticket lookup failed', { mailboxId, uid, ticketId, err: ticketErr })
    return { ok: false, reason: 'ticket_lookup_failed', error: ticketErr }
  }
  if (!ticket) {
    // The message row named a ticket that is not readable at this location —
    // deleted, or (impossible through the query above, but asserted anyway)
    // somewhere else. Same answer as no thread at all: there is nothing to
    // append to, and inventing one is what the orphan rule forbids.
    logWarn('sent-lane', 'threaded ticket is not readable at this location — treating as orphan', {
      mailboxId, uid, ticketId,
    })
    return { ok: true, outcome: 'orphan' }
  }

  // ── The message ──────────────────────────────────────────────────
  const now = new Date().toISOString()
  // The message's own Date header, clamped so a mail client with a skewed
  // clock cannot pin the ticket's queue sort key into the future. Falls back to
  // now when the header is missing or unparseable — parseEmailDate never
  // throws, which is why it exists (a RangeError on an attacker-supplied Date
  // 5xx-looped the inbound webhook once).
  // Compared as NUMBERS, not as ISO strings: a Date header far enough in the
  // future produces an EXPANDED-YEAR ISO form ('+275760-09-13T…'), whose
  // leading '+' sorts BELOW every ordinary year — a lexical compare would wave
  // exactly the value it exists to catch straight through.
  const parsedDate = parseEmailDate(payload.Date)
  const sentAt = parsedDate && Date.parse(parsedDate) <= Date.parse(now) ? parsedDate : now

  // 🔴 BARE, ALWAYS. extractRfcMessageId strips the angle brackets; mig 574's
  // unique index and every future In-Reply-To match are plain string equality
  // against this value. A bracketed value would collide with nothing, so the
  // index would silently protect nothing and our own SMTP sends would be filed
  // a second time as if a colleague had written them.
  const rfcMessageId = sanitizeDbText(extractRfcMessageId(headers))
  if (!rfcMessageId) {
    // No Message-ID header at all (scripts, a few ticketing systems). The row
    // is still filed — a staff reply the member can see beats a ticket that
    // keeps saying "needs reply" — but mig 574's index is partial, so this one
    // row cannot be deduped and a re-poll of the same UID would file it twice.
    // Logged rather than refused: losing the answer is the worse failure, and
    // the poller only re-polls a message whose tick did not complete.
    logWarn('sent-lane', 'sent message carries no Message-ID — filing it, but it cannot be deduped', {
      mailboxId, uid, ticketId,
    })
  }

  // Recipients, exactly as the inbound path stores them: to_email is the
  // PRIMARY recipient (what every reader written before EMAIL-CC.1 understands)
  // and to_emails carries the whole list beside it (mig 499). Both are capped
  // inside inboundAddresses. bcc_emails is deliberately absent and stays '{}':
  // a Bcc that was on this message is invisible in the copy the Sent folder
  // holds unless the client chose to keep it, so any value here would be a
  // guess dressed as a record.
  const toEmails = inboundAddresses(payload.ToFull, payload.To)
  const ccEmails = inboundAddresses(payload.CcFull, payload.Cc)

  // Truncate FIRST, then strip — a UTF-16 slice can orphan a surrogate pair at
  // its cut point, and that orphan fails the insert like any other.
  const htmlBody = sanitizeDbText(truncateHtmlBody(payload.HtmlBody || null))
  const textBody = sanitizeDbText((payload.TextBody || '').trim())
    || sanitizeDbText(htmlToPlainText(payload.HtmlBody))
    || ''
  const preview = inboundPreview(textBody) || (subject ? inboundPreview(subject) : '')

  // The mailbox's own address. Not required: a mailbox row whose address is
  // unusable is a configuration fault, and losing the From label on one thread
  // is cosmetic where refusing to file the reply is the customer-facing failure
  // this whole phase exists to remove.
  const fromEmail = normalizeEmail(mailbox?.address)
  if (!fromEmail) {
    logWarn('sent-lane', 'mailbox has no usable address — filing without a from_email', { mailboxId, uid })
  }

  // ── What the ticket bump would be ────────────────────────────────
  // Computed BEFORE the insert, off the ticket as it stands, because both the
  // filed path and the 23505 finish-up path apply exactly this patch. Two
  // separately-derived patches would eventually disagree about what "answered"
  // means.
  const patch = ticketPatch(ticket, { sentAt, preview, now })

  const { data: inserted, error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticketId,
    // The ticket's contact, matching what the CRM's own reply route writes —
    // the member's email history should not depend on which window the answer
    // was typed in. ON DELETE SET NULL, so an erased contact does not take the
    // correspondence with it.
    contact_id: ticket.contact_id || null,
    location_id: locationId,
    direction: 'outbound',
    from_email: fromEmail,
    to_email: toEmails[0] || null,
    to_emails: toEmails,
    cc_emails: ccEmails,
    subject,
    text_body: textBody,
    html_body: htmlBody,
    // 🔴 NULL, and it must stay null. postmark_message_id is Postmark's own
    // API id and carries a GLOBAL unique index (mig 394) plus the delivery
    // webhook's correlation. This message never went through Postmark; a
    // synthetic id here would either collide across mailboxes or invite a
    // delivery event to correlate against a message Postmark never sent.
    postmark_message_id: null,
    rfc_message_id: rfcMessageId,
    in_reply_to: sanitizeDbText(getHeader(headers, 'In-Reply-To')),
    references_header: sanitizeDbText(getHeader(headers, 'References')),
    is_internal_note: false,
    // NOT 'operator'. See MAIL_CLIENT_SOURCE.
    source: MAIL_CLIENT_SOURCE,
    // 🔴 NO author_profile_id. Nobody signed into the CRM sent this, and the
    // mailbox login is shared — the Sent copy names an address, never a person.
    // Inventing an author (the ticket's assignee, the mailbox's owner) would
    // put words in a named colleague's mouth on the permanent record.
    author_profile_id: null,
    // The message's OWN lifecycle (mig 394's vocabulary: sent | note |
    // received). It genuinely was sent. delivery_status stays NULL and always
    // will: it went out through the customer's own provider, so no Postmark
    // event is ever coming — and NULL is precisely "we know nothing"
    // (mig 498), which is the truth here rather than a gap.
    status: 'sent',
    sent_at: sentAt,
  }).select('id').single()

  if (msgErr) {
    if (msgErr.code === '23505') {
      // Mig 574 says this reply is already on this ticket. Two ways to get
      // here, and neither needs telling apart — which is the whole point of
      // having one mechanism:
      //   • our own SMTP send, filed by the reply route at send time; or
      //   • a re-poll of a message a previous tick already filed.
      //
      // The bump still runs, GUARDED BY STATE. Without it the crash window
      // between the insert and the bump would be permanent: a failed bump
      // returns ok:false, the poller holds its cursor, the retry lands here,
      // and answering a bare 'duplicate' would leave a ticket saying "needs
      // reply" with the answer sitting inside it — the exact bug this phase
      // exists to fix, reintroduced by its own error path. For our own SMTP
      // send the guard finds the ticket already advanced and writes nothing,
      // which is the "skipped" the design asks for.
      const finish = await applyTicketPatch(db, ticketId, patch, { mailboxId, uid })
      if (!finish.ok) return finish
      return { ok: true, outcome: 'duplicate', ticketId }
    }
    logError('sent-lane', 'could not file the sent message', { mailboxId, uid, ticketId, err: msgErr })
    return { ok: false, reason: 'message_insert_failed', error: msgErr }
  }

  const bumped = await applyTicketPatch(db, ticketId, patch, { mailboxId, uid })
  if (!bumped.ok) return bumped

  return { ok: true, outcome: 'filed', ticketId, messageId: inserted?.id ?? null }
}

/**
 * The ticket patch a mail-client reply earns — or an empty object when it earns
 * nothing.
 *
 * 🔴 WHAT IS NOT HERE IS AS LOAD-BEARING AS WHAT IS.
 *   • NO `status`. A staff reply is not a member reply: a closed ticket stays
 *     closed. The inbound rule is the opposite (a member's reply reopens) and
 *     the CRM's own reply route moves the ticket to `pending`; neither belongs
 *     to a message we only learned about by reading someone's Sent folder
 *     minutes later, and flipping a closed ticket back open because a colleague
 *     had answered it is a queue that grows by being used correctly.
 *   • NO `unread_count`. It counts mail somebody owes an answer to.
 *
 * WHAT CLEARING "NEEDS REPLY" ACTUALLY IS: the view and the nav badge are one
 * predicate — `status = 'open' AND last_message_direction = 'inbound'`
 * (scopeToNeedsReply). So setting last_message_direction to 'outbound' IS the
 * clear, and no separate column exists to write. That is why status can be left
 * alone and the ticket still leaves the queue.
 *
 * 🔴 THE ORDERING GUARD. The bump only applies if this reply really is the
 * ticket's newest message. The poller runs up to five minutes behind, so the
 * member can genuinely have written again between the colleague's reply and our
 * reading it — and blindly stamping 'outbound' would then clear "needs reply"
 * on a ticket where the member IS waiting, which is the double-reply failure
 * this phase exists to prevent, inverted. Same guard, same skew constant, as
 * the inbound webhook's finish-up bump. An unreadable or absent
 * last_message_at reads as "nothing newer", because the cost of guessing wrong
 * that way is a queue row out of order and the cost of guessing wrong the other
 * way is an unanswered member.
 *
 * `first_response_at` is stamped separately from the bump and survives the
 * guard: whether or not this is the newest message, it is an outbound non-note
 * one, which is exactly the column's definition (mig 482) and exactly what
 * rebuildTicketDenormals() re-derives on an unmerge. Leaving it null would make
 * a merge/unmerge round-trip silently change the value.
 */
function ticketPatch(ticket, { sentAt, preview, now }) {
  const patch = {}

  const messageAt = Date.parse(sentAt)
  const ticketAt = ticket?.last_message_at ? Date.parse(ticket.last_message_at) : 0
  const isNewest = !Number.isFinite(ticketAt) || ticketAt < messageAt - BUMP_SKEW_MS
  if (isNewest) {
    // sentAt, not `now`: the reply went out when it went out, and
    // last_message_at is the queue's sort key. The guard above has already
    // established it is later than whatever the ticket held.
    patch.last_message_at = sentAt
    patch.last_message_direction = 'outbound'
    patch.last_message_preview = preview
  }

  if (shouldStampFirstResponse({
    firstResponseAt: ticket?.first_response_at,
    direction: 'outbound',
    isInternalNote: false,
  })) {
    patch.first_response_at = sentAt
  }

  if (Object.keys(patch).length) patch.updated_at = now
  return patch
}

/**
 * Apply the patch, and judge what it touched.
 *
 * An empty patch is a real answer, not a no-op to paper over: it means the
 * ticket already reflects this reply (our own SMTP send) or has moved on past
 * it (the member wrote again). Writing nothing is correct in both.
 *
 * A DB error is transient and returns ok:false, so the poller holds its cursor
 * and the retry lands on the 23505 path, which re-runs this same patch.
 *
 * A zero-row UPDATE is NOT an error in PostgREST (CLAUDE.md), and it is not
 * transient either: the ticket was read moments ago, so zero rows means it has
 * been deleted — which cascades its messages away too, including the one just
 * filed. A retry cannot help and would loop the lane forever on a message that
 * no longer has anywhere to go, so it is logged loudly and treated as done.
 */
async function applyTicketPatch(db, ticketId, patch, { mailboxId, uid }) {
  if (!Object.keys(patch).length) return { ok: true }

  const { data, error } = await db.from('email_tickets')
    .update(patch)
    .eq('id', ticketId)
    .select('id')
  if (error) {
    logError('sent-lane', 'ticket bump failed — the reply is filed but the ticket still reads as unanswered', {
      mailboxId, uid, ticketId, err: error,
    })
    return { ok: false, reason: 'ticket_bump_failed', error }
  }
  if (!Array.isArray(data) || data.length === 0) {
    logError('sent-lane', 'ticket bump matched no rows — the ticket has gone since it was read', {
      mailboxId, uid, ticketId,
    })
  }
  return { ok: true }
}
