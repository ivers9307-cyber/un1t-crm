// EMAIL-OUTBOUND-SERVER.1 — the SEND path for ticket mail (reply + compose).
//
// WHY THIS FILE EXISTS
// Richard's topology is that marketing and the support inbox live on SEPARATE
// Postmark servers, so a bad campaign can never make a support reply bounce.
// Inbound honoured that from day one — the ticketing server has its own
// inbound stream and webhook token. Outbound did not: both ticket routes
// called sendEmail(), which resolves POSTMARK_API_KEY || POSTMARK_SERVER_TOKEN
// (the MARKETING server, ~3,280 sends in 30 days). Every support reply left on
// the same server, the same streams and the same sender reputation as the bulk
// campaigns — precisely what the separation exists to prevent.
//
// Three things move together here, because they are one decision:
//   1. the SERVER   — POSTMARK_EMAIL_INBOX_SERVER_TOKEN, ticket sends only
//   2. the STREAM   — Postmark's `email-send` stream on that server
//   3. the FROM     — the ticket's own mailbox address, when it can be sent from
//
// ─────────────────────────────────────────────────────────────────────
// TWO THINGS CALLED "STREAM", AND THEY MUST NEVER TOUCH
//
//   THIS APP'S stream  : 'broadcast' | 'outbound'. Our own vocabulary. It
//     decides consent family (consentFieldForStream: 'outbound' →
//     email_administrative), open/click tracking, the List-Unsubscribe gate,
//     and the value written to email_sends.postmark_stream /
//     campaigns.postmark_stream (CHECK-constrained by mig 302).
//   A POSTMARK message stream id : 'email-send'. An opaque provider slug,
//     scoped to ONE Postmark server, meaningless to this application.
//
// A ticket reply is BOTH: internally 'outbound' (transactional, gated on
// email_administrative, no marketing consent gate, no unsubscribe footer) AND
// on the wire `MessageStream: 'email-send'`. Two values, two jobs.
//
// Let the Postmark id leak into the internal concept and it is read as
// "not broadcast" — which happens to be true today, so nothing breaks, no test
// fails, and the send is quietly classified by a string that means nothing
// here. The day someone maps our streams to consent families by exclusion, a
// support reply is filed under the wrong lawful basis. That is a GDPR-review
// bug, not a runtime one, so it has to be prevented structurally rather than
// caught. Hence: separate parameter (sendEmail's `postmarkStream`, wire-only),
// separate constant (TICKET_INTERNAL_STREAM below), and the routes write the
// CONSTANT to email_sends — never the resolved Postmark id.
//
// ─────────────────────────────────────────────────────────────────────
// FAIL-SAFE SHAPE, borrowed from src/lib/tenant-email.js
//
// Nothing here throws. Every function returns a verdict and the ROUTE decides
// what to do with it — a send path must not blow up on a config lookup. But
// "never throws" is not "always sends": see NOT CONFIGURED below.
//
// ─────────────────────────────────────────────────────────────────────
// MAILBOX-CONNECT.7 — THERE ARE NOW TWO TRANSPORTS, AND THE ROUTES DO NOT
// KNOW WHICH ONE RAN.
//
// A mailbox connected over IMAP/SMTP (the mailbox connector, design §4) sends
// its replies over its OWN provider's SMTP rather than through Postmark,
// because Postmark cannot DKIM-sign a domain the business does not control.
// `email_mailboxes.egress` ('postmark' | 'smtp', mig 572) is the switch, and
// sendTicketEmail branches on it in its FIRST statement — ahead of the server
// token, the stream and plannedFroms(), all three of which are Postmark
// vocabulary that an SMTP send has no answer for.
//
// THE OLD PATH IS UNTOUCHED, AND THAT IS A REQUIREMENT RATHER THAN A HOPE.
// The new `mailbox` parameter is optional; absent — every caller as written
// today — or `egress: 'postmark'` runs exactly the code that ran before, in
// the same order, producing the same Postmark request and the same verdict
// object with the same keys. The suite pins it. This is the whole reason the
// switch is a branch at the top rather than a condition threaded through
// plannedFroms(): a transport that shares the From-resolution code would
// eventually inherit its fallback, which on SMTP is a silent change of the
// address the customer sees (see smtp-send.js's header for why).

import { sendEmail } from './postmark'
import { logError } from './log'
import { sendViaSmtp } from './mail/smtp-send'

/**
 * THIS APP'S internal stream for all ticket mail. Ticket mail is
 * transactional: gated on email_administrative, no marketing-consent gate, no
 * unsubscribe footer.
 *
 * Exported so the routes stamp email_sends.postmark_stream from the SAME
 * constant they send with. That is the structural half of the guard above —
 * there is no expression anywhere in the ticket paths that could evaluate to a
 * Postmark stream id and land in that column.
 */
export const TICKET_INTERNAL_STREAM = 'outbound'

/** The Postmark message stream id used when the env var is unset. */
export const DEFAULT_INBOX_MESSAGE_STREAM = 'email-send'

/**
 * Postmark ErrorCodes that mean "this From address cannot be sent from on this
 * account" — 400 "Sender Signature not found" and 401 "Sender signature not
 * confirmed", both HTTP 422 (postmarkapp.com/developer/api/overview).
 *
 * These are the ONLY codes that trigger the From fallback below. Everything
 * else — inactive recipient (406), invalid request (300), rate limit (429),
 * a stream that does not exist on this server (1235) — is a real failure the
 * operator has to see, and retrying it would send twice or hide the cause.
 */
export const SENDER_SIGNATURE_ERROR_CODES = Object.freeze([400, 401])

/**
 * How long a From address is remembered as unsendable. Short on purpose: the
 * fix (verify the domain in Postmark) is an operator action taken elsewhere,
 * and the send path must pick it up on its own rather than waiting for a
 * deploy. Ten minutes bounds the wasted round-trips to ~6/hour per address.
 */
const UNVERIFIED_FROM_TTL_MS = 10 * 60_000

const unverifiedFrom = new Map()

/** Test hook — clears the module-level unverified-From cache between tests. */
export function _resetInboxSenderCache() {
  unverifiedFrom.clear()
}

/**
 * The ticketing server's token, or null.
 *
 * DELIBERATELY NOT resolvePostmarkToken(). That helper resolves the GLOBAL
 * (marketing) server, and falling back to it here would send support mail on
 * marketing reputation — the exact defect this module exists to fix — while
 * looking completely healthy from the CRM. There is no safe fallback, so there
 * is no fallback.
 */
export function resolveInboxServerToken() {
  return process.env.POSTMARK_EMAIL_INBOX_SERVER_TOKEN || null
}

/**
 * The Postmark message stream id for the ticketing server.
 *
 * Confirmed by Richard as `email-send`. Kept env-overridable because a stream
 * can be deleted and recreated with a different id, and that should be a
 * config change rather than a deploy. Read fresh each call so it reflects live
 * config.
 *
 * A WRONG value here is loud, not silent: Postmark rejects the send with
 * ErrorCode 1235 ("The 'MessageStream' provided does not exist on this
 * server") and the operator sees that text. It is not in
 * SENDER_SIGNATURE_ERROR_CODES, so it is never retried.
 */
export function inboxMessageStream() {
  const configured = process.env.POSTMARK_EMAIL_INBOX_STREAM
  return (typeof configured === 'string' && configured.trim()) || DEFAULT_INBOX_MESSAGE_STREAM
}

/**
 * The From we fall back to when the mailbox address cannot be sent from.
 * A domain we own and Postmark has verified. Mirrors sendEmail's own default
 * chain so what we record is what went on the wire.
 */
export function fallbackFromAddress() {
  return process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>'
}

/**
 * Operator-facing refusal when the ticketing server token is absent.
 *
 * THE DECISION, STATED ONCE: an unconfigured ticketing server REFUSES THE
 * SEND. It does not quietly fall back to the marketing server.
 *
 * The alternative — fall back and log — restores the exact bug this task
 * removes, in the one condition where nobody is looking, and it is invisible
 * from the CRM: the operator sees a normal "sent", the reply rides marketing
 * reputation, and the only symptom is a bounce rate nobody attributes. A
 * silent correct-looking wrong answer is worse than a loud stop.
 *
 * Refusing is cheap HERE and nowhere else, because both ticket routes send
 * BEFORE they write: a refusal writes nothing, advances no ticket, creates no
 * orphan, and the retry after setting the var is exact. And the message names
 * the variable, so the fix is a single Vercel setting away rather than a
 * debugging session. (Same posture as isPostmarkAccountConfigured() in
 * postmark-account.js: answer cleanly instead of throwing a 500.)
 *
 * It is also unreachable in production — the var is set — so the cost lands on
 * preview deploys and local dev, where a stopped support reply harms nobody.
 */
export const INBOX_NOT_CONFIGURED_MESSAGE =
  'Ticket email is not configured, so nothing was sent. ' +
  'POSTMARK_EMAIL_INBOX_SERVER_TOKEN (the support inbox’s own Postmark server token) ' +
  'is not set. Nothing has changed — try again once it is.'

/**
 * True when a Postmark rejection means the From address has no usable sender
 * signature. Pure.
 *
 * Primary signal is the numeric ErrorCode. The message check is a second net
 * for the case where Postmark answers 422 with a code we have not listed —
 * getting the code set slightly wrong should degrade to "send from a domain we
 * own", not to "support replies stop". It is bounded by the 422 so it can
 * never widen a transport error into a retry.
 */
export function isSenderSignatureError(err) {
  if (!err) return false
  if (SENDER_SIGNATURE_ERROR_CODES.includes(err.errorCode)) return true
  if (err.httpStatus === 422 && typeof err.message === 'string') {
    return /sender signature/i.test(err.message)
  }
  return false
}

/**
 * The From addresses to try, in order. Pure — the caller supplies the cache
 * verdict so this stays a statement of the rule rather than a lookup.
 *
 * THE RULE
 *   • mailbox address, when the ticket has one and it is not known-unsendable
 *   • then the fallback (a domain we own), Reply-To still the mailbox
 *
 * Hatch Street's accounts@hatchstreetfitness.com is verified, so it is the
 * only attempt that ever runs there. Stillorgan's stillorgan@un1t.com sits on
 * a domain the business does not control and can never be DKIM-verified, so
 * its first attempt is rejected by Postmark (nothing is sent, nothing is
 * queued: a 422 is a refusal at submit time, not a bounce), the address is
 * cached as unsendable, and the second attempt goes out on a domain we own
 * with Reply-To pointing at the real mailbox — i.e. exactly today's behaviour
 * for that studio.
 *
 * NO DOMAIN LIST ANYWHERE. Sender signatures and domains are ACCOUNT-level
 * Postmark resources (see postmark-account.js) with their own verification
 * state that changes without telling us; a list in our source or our env would
 * be a second, always-stale copy of that truth. Postmark is the authority, so
 * we ask it, once, and cache the "no".
 *
 * @param {{ mailboxAddress?: string|null, fallback: string, skipMailbox?: boolean }} opts
 * @returns {Array<{ from: string, degraded: null|'no_mailbox'|'unverified_sender' }>}
 */
export function plannedFroms({ mailboxAddress, fallback, skipMailbox = false }) {
  const mailbox = typeof mailboxAddress === 'string' ? mailboxAddress.trim() : ''
  const attempts = []
  if (mailbox && !skipMailbox) attempts.push({ from: mailbox, degraded: null })
  // A mailbox that IS the fallback needs no second attempt — it would be the
  // same request twice.
  if (fallback && fallback !== mailbox) {
    attempts.push({
      from: fallback,
      // Which kind of degradation, so the caller can say something true about
      // it: no mailbox at all (a deleted address, elevated caller) is not the
      // same as a mailbox we may not send from.
      degraded: mailbox ? 'unverified_sender' : 'no_mailbox',
    })
  }
  return attempts
}

function isKnownUnverified(address) {
  if (!address) return false
  const until = unverifiedFrom.get(address.toLowerCase())
  if (!until) return false
  if (until <= Date.now()) {
    unverifiedFrom.delete(address.toLowerCase())
    return false
  }
  return true
}

function markUnverified(address) {
  if (address) unverifiedFrom.set(address.toLowerCase(), Date.now() + UNVERIFIED_FROM_TTL_MS)
}

/**
 * Send one ticket email on the SUPPORT INBOX'S OWN Postmark server.
 *
 * Never throws. Returns a verdict:
 *   { ok: true,  result, fromEmail, degraded }   — `fromEmail` is what actually
 *       went on the wire, so the caller logs the truth rather than a guess.
 *   { ok: false, reason: 'not_configured', error }  — no server token; nothing
 *       was attempted. Callers answer 503.
 *   { ok: false, reason: 'send_failed', error }     — Postmark refused. Callers
 *       answer 400, exactly as they did when sendEmail threw.
 *
 * Deliberately does NOT consult resolveEmailSender() (the INTEG-B3 per-tenant
 * sending domain): ticket mail belongs on the ticketing server by topology, and
 * an org-level override would silently move it back onto a shared one. The
 * feature is unreachable today (no org has the add-on), so this is a decision
 * recorded ahead of the collision, not a behaviour change.
 *
 * TRACKING IS NOT SET HERE. sendEmail derives it from the INTERNAL stream, and
 * 'outbound' means TrackOpens:false / TrackLinks:'None' (EMAIL-NOTRACK.1 —
 * one-to-one mail is not instrumented). Passing the flags again from here
 * would fork that rule into two places.
 *
 * ─────────────────────────────────────────────────────────────────────
 * RECIPIENTS ARE NOT DECIDED HERE EITHER (EMAIL-CC.1).
 *
 * `to`/`cc`/`bcc` arrive already resolved, as the comma-separated wire strings
 * `toPostmarkFields()` produces in src/lib/email-recipients.js. That file owns
 * recipient POLICY — validation, case-insensitive dedupe across all three
 * lists, exclusion of our own addresses, the 25-address cap — and this file
 * owns TRANSPORT. Keeping the split means there is exactly one site where a
 * resolved set becomes wire values, which is what makes the Bcc guarantee
 * auditable; re-deriving or re-joining anything here would quietly become a
 * second one.
 *
 * So all three are passed STRAIGHT THROUGH, untouched. In particular `bcc`
 * goes to sendEmail's `bcc` parameter and nowhere else — it is never folded
 * into `to`/`cc` and never written into `headers` (which carries threading
 * anchors only). sendEmail sets it on Postmark's own `Bcc` API field, and
 * Postmark does not put a Bcc header on the delivered message.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ATTACHMENTS ARE NOT DECIDED HERE EITHER (EMAIL-OUTBOUND-ATTACH.1).
 *
 * `attachments` is Postmark's own array shape
 * ({ Name, Content: base64, ContentType }), passed straight through to
 * sendEmail, which only adds the key when there is something to add. PURELY
 * ADDITIVE: omitting it (every pre-existing caller, and every send without
 * files) leaves the request body byte-identical. It is threaded through here
 * rather than around this module because this is the seam that decides the
 * server, the stream and the From — an attachment path that called sendEmail
 * directly would send support mail on marketing reputation, which is the exact
 * bug this file exists to have fixed.
 *
 * THE SIZE CEILING IS NOT ENFORCED HERE. Postmark caps a message at 10 MB
 * measured AFTER base64, and the caller has to answer for that in words an
 * operator can act on — see collectOutboundAttachments() in
 * src/lib/email-outbound-attachments-server.js. A check here could only throw.
 * Note that a sender-signature retry re-sends the SAME attachments on the
 * second attempt; that is correct (the first attempt was refused at submit
 * time, so nothing was transmitted) and it is why the array is built once,
 * outside the loop.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MAILBOX-CONNECT.7 — THE OPTIONAL `mailbox` ARGUMENT IS THE TRANSPORT.
 *
 * Pass the email_mailboxes row (`{ id, address, egress }` is all that is read)
 * and an `egress` of 'smtp' routes the send to the mailbox's own SMTP server
 * instead of Postmark. Omit it — as every caller does today — and nothing
 * changes: no lookup, no branch taken, the Postmark path below runs verbatim.
 *
 * `mailboxAddress` is kept as its own parameter rather than derived from
 * `mailbox`, because the two answer different questions. A ticket whose
 * mailbox row was deleted still has an address to put in Reply-To; an elevated
 * caller answering that correspondence passes `mailboxAddress` with no
 * `mailbox` at all. Deriving one from the other would make that case
 * unrepresentable.
 *
 * ON THE SMTP BRANCH THE VERDICT GAINS ONE KEY, `deliveryTracked: false`, and
 * the Postmark branch deliberately does NOT gain `deliveryTracked: true`. An
 * SMTP send can never receive a Postmark Delivery/Bounce webhook, so mig 498's
 * NULL delivery_status is its PERMANENT state rather than a state it is
 * waiting to leave — a different fact from the one NULL usually tells, and one
 * the thread has to be able to render as "not tracked" rather than as an event
 * still in flight. Keeping the key off the Postmark verdict keeps that path
 * byte-identical to what three routes already consume.
 */
export async function sendTicketEmail({
  mailboxAddress = null,
  // MAILBOX-CONNECT.7 — the transport selector; see the docblock. Optional,
  // and defaulting to null keeps every existing call site byte-identical.
  mailbox = null,
  // EMAIL-CC.1 / EMAIL-OUTBOUND-ATTACH.1 — cc, bcc and attachments all default
  // to undefined, so a caller that passes none of them (and every caller
  // before those two tasks) produces a byte-identical sendEmail call.
  to, cc, bcc, subject, htmlBody, textBody, tag, metadata, headers, attachments,
}) {
  // ── TRANSPORT SELECTION — FIRST, BEFORE ANY POSTMARK VOCABULARY ─────
  // Ahead of resolveInboxServerToken() on purpose. Everything below this point
  // is about Postmark — its server token, its message stream, its sender
  // signatures — and none of it has a meaning for a send that leaves over the
  // customer's own SMTP. Resolving any of it first would either refuse an SMTP
  // send because OUR Postmark server is unconfigured (a wholly unrelated fact)
  // or leak a Postmark concept into a path that has no Postmark in it.
  //
  // `tag` and `metadata` are deliberately NOT forwarded. Both are Postmark
  // features: `tag` groups messages in Postmark's own UI, and `metadata`
  // carries POSTMARK-RACE.1's send marker, which exists so a Delivery webhook
  // arriving before the email_sends row can still be matched. Neither has a
  // counterpart on SMTP, and there are no webhooks to match, so passing them
  // would be bookkeeping for events that never happen.
  if (mailbox?.egress === 'smtp') {
    return sendViaSmtp({
      mailbox, to, cc, bcc, subject, htmlBody, textBody, headers, attachments,
    })
  }

  const serverToken = resolveInboxServerToken()
  if (!serverToken) {
    // Loud: this is the one condition where a support reply does not go out,
    // and the log has to say why without waiting for someone to report it.
    // No recipient in the meta — logError's contract is PII-free, and the
    // operator already gets the reason in the response.
    logError('email-inbox-send', 'POSTMARK_EMAIL_INBOX_SERVER_TOKEN is not set — refusing to send ticket mail on the marketing server')
    return { ok: false, reason: 'not_configured', error: INBOX_NOT_CONFIGURED_MESSAGE }
  }

  const postmarkStream = inboxMessageStream()
  const attempts = plannedFroms({
    mailboxAddress,
    fallback: fallbackFromAddress(),
    skipMailbox: isKnownUnverified(mailboxAddress),
  })

  let lastError = null
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]
    try {
      const result = await sendEmail({
        to,
        // EMAIL-CC.1 — pass-through, in the same shape they arrived. `bcc`
        // reaches Postmark's `Bcc` field and nothing else; see the docblock.
        cc,
        bcc,
        subject,
        htmlBody,
        textBody,
        // Reply-To stays the ticket's mailbox unconditionally — redundant when
        // it equals the From, load-bearing when the fallback fired. One line
        // that is correct in both cases beats a branch that has to stay in
        // step with the From.
        replyTo: mailboxAddress || undefined,
        // OUR vocabulary (consent + tracking + logging)…
        stream: TICKET_INTERNAL_STREAM,
        // …and POSTMARK'S, wire-only. See the header.
        postmarkStream,
        tag,
        metadata,
        headers,
        // EMAIL-OUTBOUND-ATTACH.1 — undefined for every send without files, so
        // sendEmail never adds the `Attachments` key and the payload is
        // unchanged.
        attachments,
        // The tenant-override seam carries BOTH the server token and the From
        // (src/lib/postmark.js resolveTenantOverride). Passing `sender`
        // explicitly also stops it looking up a per-tenant sender by location.
        sender: { serverToken, fromEmail: attempt.from, fromName: null },
      })
      return { ok: true, result, fromEmail: attempt.from, degraded: attempt.degraded }
    } catch (err) {
      lastError = err
      const isLast = i === attempts.length - 1
      if (isLast || !isSenderSignatureError(err)) break
      // Postmark refused the From at SUBMIT time, so nothing was sent and a
      // second attempt cannot duplicate a message.
      markUnverified(attempt.from)
      logError('email-inbox-send', 'From address has no verified sender signature — falling back', {
        from: attempt.from,
        errorCode: err?.errorCode ?? null,
      })
    }
  }

  return {
    ok: false,
    reason: 'send_failed',
    error: lastError?.message || 'Failed to send email',
  }
}
