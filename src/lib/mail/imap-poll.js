// MAILBOX-CONNECT.5 — the poller.
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §3
//
// ══ WHAT THIS IS: A PRODUCER, NOT A SECOND PIPELINE ═════════════════
// This module reads new mail off a connected IMAP account and POSTs each
// message, reshaped as a Postmark inbound payload, at the EXISTING webhook
// route (/api/webhooks/postmark-inbound/<token>). It files nothing itself: no
// ticket, no message row, no attachment row, no counter. Everything downstream
// — mailbox routing, threading, dedupe, dead-lettering, the storage quota — is
// inherited from that route, unchanged.
//
// It is the SECOND INSTANCE of supabase/functions/postmark-inbound-shim, and
// the resemblance is deliberate down to the details: build a payload, forward
// it over HTTP, treat the response exactly as Postmark would. `processInbound-
// Email` is ~500 lines and is the most safety-critical function in the estate
// (dedupe claim/release, crash-window classification, poison-text defusing,
// eight dead-letter doors). Every silent-mail-loss lesson this codebase has
// ever learned is written into it. We do not re-learn them here.
//
// 🔴 THE POST GOES OVER THE WIRE, ON PURPOSE. Importing the route handler
// would be faster and would look tidier. It would also mean this path no
// longer exercises the route's own auth, body limits, retry semantics and
// error mapping — i.e. it would be a second pipeline wearing the first one's
// clothes. Over HTTP, "indistinguishable from Postmark" is a property of the
// system rather than a claim in a comment.
//
// ══ THE CURSOR IS THE WHOLE SAFETY STORY (§3.3) ═════════════════════
// `email_mailbox_ingress.last_uid` ADVANCES ONLY ON A 2xx FROM THE ROUTE.
//
//   • 2xx (including a 200 that dead-lettered) → the message is recorded
//     somewhere a human can see. Advance.
//   • 5xx / 503 / a network failure → the route did NOT record it. Leave the
//     watermark, stop the mailbox for this tick, and let the next tick retry.
//     That is precisely Postmark's own retry behaviour, so the route sees the
//     pattern it was hardened against (EMAIL-DEDUPE-RELEASE.1 releases its
//     dedupe claim on every >= 500 for exactly this reason).
//   • the payload-deterministic statuses are the exception, and it is a
//     considered one — see `PERMANENT_REJECTION_STATUSES` below.
//   • "retry" must have a FLOOR, or it is just a stall with better manners.
//     After MAX_STALL_TICKS of zero progress the poller stops taking a
//     retryable refusal at face value and proves which side is broken; read
//     the deferral in pollOpenFolder() before changing any of it.
//
// Getting this backwards loses mail silently, which is the failure class this
// entire subsystem's history is about.
//
// 🔴 AND A 2xx IS ONLY EARNED BY A COMPLETE PAYLOAD. A body part that failed
// to download is NOT "a ticket with no text" — it is silent, permanent data
// loss, because the deterministic MessageID makes every re-POST a
// `200 deduped` and the body can never be back-filled. attachBodies() returns
// a verdict and pollOpenFolder() judges it; see IMAP-BLANKBODY.1 there.
//
// A crash between a 2xx and the cursor write costs a re-POST on the next tick,
// never a lost message: the synthetic MessageID is deterministic, so the route
// answers `200 deduped` and we advance. Duplicate work, never duplicate mail.
//
// ══ THE OTHER FOUR INVARIANTS ═══════════════════════════════════════
// COLD START INGESTS NOTHING (§3.5). The first successful connect for a
// (mailbox, folder) records UIDVALIDITY + the current highest UID and returns.
// New mail only, no backfill, EVER — a backfill would file years of a
// customer's correspondence as fresh tickets, with push notifications.
//
// A UIDVALIDITY CHANGE RE-ANCHORS, NEVER RE-INGESTS (§3.3). Every UID we hold
// becomes meaningless; the honest response is to anchor at the current highest
// UID, say so loudly, and accept that anything that arrived in the gap is not
// picked up. Replaying the mailbox instead would re-file it in its entirety.
//
// PER-MESSAGE ISOLATION. One message that cannot be prepared or that the route
// permanently refuses must not stall the mailbox behind it. It is logged at
// error level and stepped over.
//
// PER-MAILBOX ISOLATION. One tenant's revoked app password must never delay or
// abort another tenant's poll. pollMailbox() NEVER THROWS, the multi-tenant
// loop runs mailboxes through a bounded pool, and each result is judged on its
// own. This is the multi-tenant guarantee, not a nicety — and it is why the
// sweep carries a WALL-CLOCK BUDGET (DEFAULT_TICK_BUDGET_MS): without one, a
// tenant who controls their own mailbox contents can spend the whole function
// invocation and every other tenant loses the tick, with the kill landing
// before the caller's stampHeartbeat().
//
// A MESSAGE IS FILED INTO THE MAILBOX THAT RECEIVED IT, never the one a header
// names (IMAP-ROUTE-FORGE.1). The route's recipient precedence puts the
// sender-written `To:` above the delivery address, so the poller strips every
// OTHER connected mailbox address out of the payload before forwarding. See
// loadActiveMailboxAddresses() here and dropForeignMailboxes() in
// imap-message.js.
//
// ══ WHAT THIS MODULE DELIBERATELY DOES NOT DO ═══════════════════════
//   • It never writes an IMAP flag. withMailbox() opens read-only and this
//     file never asks for anything else (§3.4).
//   • It never meters attachment bytes. storeOne() in
//     src/lib/email-attachments-server.js already reserves quota from the
//     staging marker, exactly as it does for an inline attachment. Metering
//     here as well would bill every IMAP attachment twice and silently halve
//     the mailbox's 5 GB. The Edge shim does not meter, for the same reason.
//   • It never sanitises body text. The route runs sanitizeDbText() over
//     Subject / FromFull.Name / TextBody / HtmlBody / threading headers
//     (EMAIL-INBOUND-POISON.1). Two sanitisers means two things to keep in
//     step.
//   • It never touches src/lib/recon/ — that is the receipt-hunt engine, a
//     live feature that happens to use the same IMAP library.

import { getAppUrl } from '../app-url'
import { mapWithConcurrency } from '../concurrency'
import { discardStagedAttachments } from '../email-attachments-server'
import { HTML_BODY_MAX_CHARS } from '../email-inbox'
import { logError, logInfo, logWarn } from '../log'
import { resolveAuth } from './auth-strategy'
import { fetchSince, withMailbox } from './imap-connection'
import { canStageForMessage, stageImapAttachments } from './imap-attachments'
import { SYNTHETIC_ID_RE, toInboundPayload } from './imap-message'
import { isConfigured } from './secret-box'

/* ────────────────────────────── constants ─────────────────────────────── */

/** The CRM's own name for the lane, not the IMAP path. See mig 571's comment. */
export const DEFAULT_FOLDER = 'inbox'

/**
 * How the lane name maps onto a real IMAP folder.
 *
 * 'inbox' is INBOX and nothing else (§3.4): `[Gmail]/All Mail` contains SENT
 * mail, so polling it would re-ingest every reply Phase 7 sends over SMTP as
 * if a member had written it. Phase 8's 'sent' lane resolves to the
 * PROVIDER-SPECIFIC folder stored on the credential row (Gmail's is
 * `[Gmail]/Sent Mail`), which is why it cannot be a constant here.
 */
function folderPathFor(folder, credential) {
  if (folder === DEFAULT_FOLDER) return 'INBOX'
  if (folder === 'sent') {
    const path = typeof credential?.sent_folder === 'string' ? credential.sent_folder.trim() : ''
    return path || null
  }
  return null
}

/**
 * Messages ingested per mailbox per tick.
 *
 * Deliberately modest. Each one costs a body download, possibly several
 * attachment downloads and uploads, and one round trip to our own webhook, and
 * the whole multi-tenant sweep shares a single function invocation. A backlog
 * drains at 25 × (60/5) = 300 messages an hour, which clears anything a
 * connected studio mailbox realistically holds, and fetchSince() takes the
 * OLDEST `cap` rather than the newest so draining never skips a message.
 */
export const DEFAULT_CAP = 25

/** IMAP accounts polled at once. See the pool comment in pollAllMailboxes(). */
export const POLL_CONCURRENCY = 3

/**
 * Mailboxes POLLED in one tick — a bound on the work, not on the query.
 *
 * 🔴 The distinction is the whole of IMAP-PAGE.1. This used to be a bare
 * `.limit(200)` with no `.order()`, which is the 1,000-row-cap invariant's
 * exact anti-pattern: PostgREST's physical row order is stable, so an estate
 * past 200 connected mailboxes handed back THE SAME 200 every tick, forever,
 * and orderByLastRun() then "fairly" sorted a set that had already been
 * truncated unfairly. The 201st mailbox would never have been polled once —
 * while the comment below promised "a mailbox cannot be starved".
 *
 * Now the LIST is read in full (range-paginated, explicitly ordered — see
 * loadPollableMailboxes), ordered by least-recently-run, and only THEN cut to
 * this ceiling. So the ceiling still bounds a tick's work, but the mailboxes it
 * drops are the ones polled most recently, and they sort to the front of the
 * next tick. Phase 11.1 owns the real per-tenant limit.
 */
export const MAX_MAILBOXES_PER_TICK = 200

/**
 * Page size and hard stop for the paginated mailbox read.
 *
 * The scan ceiling exists so a runaway table cannot turn one tick into an
 * unbounded scan; hitting it logs, and the fair ordering means the mailboxes
 * beyond it are still reached — just not in this tick.
 */
const MAILBOX_PAGE_SIZE = 500
const MAX_MAILBOXES_SCANNED = 5000

/**
 * 🔴 WALL-CLOCK BUDGET FOR ONE TICK (IMAP-BUDGET.1).
 *
 * The sweep had no deadline anywhere, and the arithmetic that made that fatal
 * is short: 25 messages × a 30s forward timeout is 750s against a 300s
 * `maxDuration`, and a tenant controls their own mailbox contents, so it is
 * trivially reachable rather than theoretical. The function is killed mid-sweep
 * — every OTHER tenant loses its tick entirely, and the kill lands before the
 * caller's stampHeartbeat(), so the poller reports STALE while behaving exactly
 * as designed. That contradicts the per-mailbox isolation guarantee this
 * module opens with.
 *
 * 180s of a 300s budget leaves 120s of headroom, which is deliberately more
 * than one in-flight forward (30s) plus an IMAP teardown plus the heartbeat
 * write: the deadline is only CHECKED between units of work, so the overshoot
 * is bounded by the longest single unit, not by zero.
 *
 * Stopping is clean, never an error: whatever the tick earned is kept (the
 * watermark holds every accepted message), `last_ok_at` still moves, and the
 * next tick picks up where this one stopped. A budget stop is a healthy tick.
 */
export const DEFAULT_TICK_BUDGET_MS = 180_000

/** The route's own path. Stated, not configurable — see resolveInboundTarget. */
const INBOUND_PATH = '/api/webhooks/postmark-inbound'

/**
 * A hung forward must not eat the cron's budget. The shim uses the same 30s
 * for the same hop; past it we treat the message as un-delivered and retry on
 * the next tick, which is what a Postmark→Vercel timeout does today.
 */
const FORWARD_TIMEOUT_MS = 30_000

/**
 * 🔴 THE STATUSES THAT ADVANCE THE WATERMARK WITHOUT FILING ANYTHING.
 *
 * Each one is deterministic in the PAYLOAD: the next tick builds a byte-
 * identical body and gets a byte-identical answer, so treating any of them as
 * retryable parks the mailbox behind one message FOREVER and every email after
 * it is lost in silence. That is far worse than stepping over a message that
 * cannot be represented, which is logged at error level with its UID so it can
 * be read out of the mailbox by hand.
 *
 *   400  the route's own two rejections — a body that is not JSON, and a
 *        missing MessageID.
 *   413  🔴 NOT ours, and that is exactly why it was missed. A POST over
 *        Vercel's ~4.5 MB limit is answered with a PLAIN-TEXT 413 BEFORE THE
 *        ROUTE RUNS, so it is neither a 2xx nor the route's 400 — it took the
 *        "halt and retry" branch and the mailbox retried the same oversized
 *        message every tick, forever, ingesting nothing else ever again with a
 *        green heartbeat throughout (IMAP-FORWARD-413.1). The emission caps in
 *        imap-message.js plus enforceForwardBudget() below should make this
 *        unreachable; it is listed anyway, because "should be unreachable" is
 *        what the last version of this comment effectively said too.
 *   415  a content type the platform refuses. Ours is a constant, so this can
 *        only ever be a deterministic platform answer.
 *   422  semantically "the payload is unprocessable". Nothing on this path
 *        emits one today; it is here because a status that means "your body is
 *        wrong" is by construction not fixed by resending the same body.
 *
 * Every OTHER non-2xx halts the mailbox for this tick without advancing —
 * including 401, 403, 404 (the token or base URL is wrong for EVERY message,
 * so stepping over would drain a mailbox into nothing), 408 and 429 (both
 * explicitly "try again"), and every 5xx.
 */
const PERMANENT_REJECTION_STATUSES = new Set([400, 413, 415, 422])

/**
 * Consecutive zero-progress ticks after which the poller stops taking a
 * retryable refusal at face value and PROVES which side is broken.
 *
 * 🔴 Read the deferral machinery in pollOpenFolder() before touching this. The
 * problem it solves is that "halt and retry" has no floor: any deterministic
 * non-2xx the list above does not name — a route 5xx thrown on one poisonous
 * message is the live example, which is the entire reason
 * EMAIL-INBOUND-POISON.1 exists — stalls the mailbox permanently, and nothing
 * distinguishes that from a genuine outage except time.
 *
 * The naive fix is "step over after N tries", and it is WRONG: during a long
 * outage every mailbox in the estate would bleed one real message per tick, so
 * a silent stall would have been traded for silent LOSS, which is the worse of
 * the two (CLAUDE.md's rule, learned four times over on BAREWRITE). So the
 * escape requires positive proof instead — see the deferral.
 *
 * Twelve ticks is not twelve five-minute ticks: the transport backoff doubles
 * from the second failure (0, 10m, 20m, 40m, 80m, then a 2h ceiling), so
 * reaching twelve takes the better part of a day of continuous failure on the
 * same message. Nothing healthy gets near it.
 */
const MAX_STALL_TICKS = 12

/**
 * 🔴 The serialised ceiling for one forwarded payload.
 *
 * Vercel rejects a request body over ~4.5 MB with a plain-text 413 raised
 * before the route runs. The per-field caps in imap-message.js keep ordinary
 * mail nowhere near this, but they are counted in CHARACTERS and the wire is
 * measured in BYTES: JSON.stringify escapes a control byte to `\u00XX`, six
 * bytes per character, so the 600k characters of body this poller already
 * allows can inflate to ~3.6 MB on a body that is mostly control bytes. Only a
 * measurement can promise the budget, so this is the one that does.
 *
 * 3.5 MB leaves a megabyte of headroom for the platform's own accounting.
 */
const MAX_FORWARD_BYTES = 3_500_000

/**
 * Ceiling on ONE body part, enforced by imapflow's own byte limiter.
 *
 * A 40 MB HTML body must not become a 40 MB buffer inside a serverless
 * function (the risk table's "large message exhausts function memory"). The
 * limiter TRUNCATES rather than failing, which is the right shape here: a
 * truncated body is still a ticket someone can answer, where a refusal would
 * be a stalled mailbox.
 */
const MAX_BODY_PART_BYTES = 1_000_000

/**
 * Ceiling on the body text we put ON THE WIRE.
 *
 * HtmlBody: the shim truncates to exactly this before forwarding and the route
 * truncates again to the same number before storing (truncateHtmlBody), so
 * nothing that would have been kept is lost.
 *
 * TextBody: capped at the same number, which the shim does NOT do. Postmark
 * bounds its own payloads at 35 MB; an IMAP text part has no such ceiling, and
 * a POST over Vercel's ~4.5 MB body limit is rejected as a PLAIN-TEXT 413
 * before the route runs — a non-2xx, i.e. a permanently stalled mailbox. A
 * 300k-character plain-text email is a data dump, not correspondence.
 */
const MAX_TEXT_BODY_CHARS = HTML_BODY_MAX_CHARS

/**
 * Backoff, per failure CLASS (§9.3 — "a revoked password is an operator
 * action, not an outage").
 *
 * Nothing pauses on the FIRST failure: the cron runs every five minutes, so
 * the next tick is already the right retry for a dropped connection or a
 * momentary 500, and pausing on a blip is how a mailbox stops receiving for an
 * hour because a socket closed once.
 *
 * From the second consecutive failure the pause doubles. A transport fault is
 * usually transient, so it starts short and tops out inside a couple of hours.
 * An auth fault is not going to fix itself — an app password has been revoked,
 * or 2SV was reset — so it starts long and ends at a day, which IS the
 * auto-pause the plan calls for (5.5). Both are ceilings, not silences:
 * `last_error` and `paused_until` are on the row for the settings card to
 * render, and a pause that nobody can see is the failure this is guarding.
 */
const TRANSPORT_BACKOFF_BASE_MS = 10 * 60_000
const TRANSPORT_BACKOFF_MAX_MS = 2 * 60 * 60_000
const AUTH_BACKOFF_BASE_MS = 30 * 60_000
const AUTH_BACKOFF_MAX_MS = 24 * 60 * 60_000

/** Longest error we store — `last_error` is read back and rendered in the UI. */
const MAX_ERROR_CHARS = 500

/**
 * Explicit column lists, never `select('*')`.
 *
 * The credential read is the one place in the poll path that touches
 * ciphertext, and it names the columns it needs so that a future column
 * (a refresh token, a provider secret) is not swept into this scope by
 * accident. Everything after resolveAuth() sees an auth object, never a
 * credential row.
 */
const CREDENTIAL_COLUMNS = [
  'mailbox_id', 'provider', 'auth_type', 'username',
  'secret_ciphertext', 'oauth_access_token_ciphertext', 'oauth_expires_at',
  'imap_host', 'imap_port', 'imap_secure', 'sent_folder',
].join(', ')

const INGRESS_COLUMNS = [
  'mailbox_id', 'folder', 'uidvalidity', 'last_uid',
  'last_run_at', 'last_ok_at', 'last_error', 'consecutive_failures', 'paused_until',
].join(', ')

/**
 * The mailbox columns the poller itself needs.
 *
 * Deliberately NOT one of the two named MAILBOX_COLUMNS constants — those
 * belong to the settings routes (`…/email/mailboxes/_helpers.js`) and the
 * ticket routes (`…/email/tickets/_helpers.js`), which are owned by other
 * phases and select for other purposes. `address` is the load-bearing one: it
 * becomes OriginalRecipient, which is what routes the mail.
 */
const POLL_MAILBOX_COLUMNS = 'id, location_id, address, label, active, ingress'

/* ─────────────────────────── small pure helpers ───────────────────────── */

/**
 * 🔴 A UID-space number as a plain Number, whatever shape it arrived in.
 *
 * imapflow types `MailboxObject.uidValidity` as a **BigInt** while PostgREST
 * hands a `bigint` column back as a Number (or a string, for values past
 * 2^53). Two traps, both silent:
 *
 *   • `12345n !== 12345` is TRUE, so comparing the two raw would report a
 *     UIDVALIDITY change on every single tick — the mailbox would re-anchor
 *     forever and NEVER INGEST A SINGLE MESSAGE, while every row and log line
 *     said the poll succeeded;
 *   • `JSON.stringify` THROWS on a BigInt, so writing one back through
 *     supabase-js would fail the cursor update with "Do not know how to
 *     serialize a BigInt" — a fault in the one write that must never be lost.
 *
 * UIDVALIDITY and UID are both 32-bit unsigned in RFC 3501, so Number holds
 * either exactly. Normalising BOTH SIDES through this function is what makes
 * the comparison mean what it reads like.
 */
export function toUidNumber(value) {
  if (value == null) return null
  if (typeof value === 'bigint') return Number(value)
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Is this failure the operator's to fix, or an outage?
 *
 * The distinction is required (§9.3) and it is not cosmetic: it picks the
 * backoff curve, and Phase 9 alerts on the two differently. imapflow marks
 * every LOGIN/AUTHENTICATE rejection with `authenticationFailed` and carries
 * the server's response code, so the flag is the primary signal and the text
 * match is only a backstop for a server that answers in prose.
 */
export function classifyImapFailure(err) {
  if (err?.authenticationFailed === true) return 'auth'
  const code = String(err?.serverResponseCode || '')
  if (/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|PRIVACYREQUIRED|EXPIRED/i.test(code)) return 'auth'
  const text = String(err?.responseText || err?.message || '')
  return /authenticat|invalid credentials|login failed|application-specific password|web login required/i
    .test(text)
    ? 'auth'
    : 'transport'
}

/**
 * How long to pause after `failures` consecutive failures of `kind`.
 *
 * Returns 0 for the first failure — see the backoff constants' comment.
 */
export function backoffMs(kind, failures) {
  const n = Math.trunc(Number(failures) || 0)
  if (n < 2) return 0
  const base = kind === 'auth' ? AUTH_BACKOFF_BASE_MS : TRANSPORT_BACKOFF_BASE_MS
  const max = kind === 'auth' ? AUTH_BACKOFF_MAX_MS : TRANSPORT_BACKOFF_MAX_MS
  // Clamped before the shift so a corrupt counter cannot produce Infinity.
  const doublings = Math.min(n - 2, 24)
  return Math.min(base * 2 ** doublings, max)
}

/**
 * An error string that is safe to persist and to show an operator.
 *
 * Mirrors safeError() in imap-connection.js, which is module-private there.
 * The duplication is small and deliberate: `last_error` is rendered in the
 * settings UI, so a credential must never reach it even if a future imapflow
 * version starts echoing the LOGIN command, and an IMAP server's multi-
 * kilobyte BAD response must not ride along on every read of that card.
 */
/**
 * What the OPERATOR is told when a dial fails, by category.
 *
 * Deliberately fixed strings. The two categories a poll can fail in are worth
 * distinguishing because the fixes are different — a revoked app password is an
 * operator action, an unreachable host is usually a typo or an outage — but
 * nothing below varies with what the remote end said, so a mailbox that is
 * really pointed at an internal service reports exactly what an unreachable
 * public one reports. See the call site for why that matters.
 *
 * @param {'auth'|'transport'} kind
 */
export function operatorFacingDialError(kind) {
  return kind === 'auth'
    ? 'The mail server refused this login. If the account uses two-step verification the password here must be an app password, and a revoked one fails exactly like this — generate a new one and save it again.'
    : 'Could not reach the mail server. Check the incoming server and port, then try again; if they are right, the provider may be having an outage.'
}

function safeErrorText(err, auth) {
  let out = String(err?.responseText || err?.message || err || 'unknown error')
  for (const secret of [auth?.pass, auth?.accessToken]) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out.slice(0, MAX_ERROR_CHARS)
}

/**
 * Where the payload is POSTed, and the same URL with the secret removed for
 * logging.
 *
 * Mirrors the Edge shim: the PATH is a constant rather than configuration, so
 * the forward target cannot be pointed somewhere else by an env var alone; the
 * HOST comes from CRM_WEBHOOK_BASE_URL (the shim's own variable, so one value
 * covers both producers) and falls back to this deployment's own origin.
 *
 * Resolved BEFORE the IMAP connection is opened. A deployment missing its
 * token would otherwise log in to a customer's mailbox, download a message and
 * only then discover it has nowhere to send it.
 */
export function resolveInboundTarget(env = process.env) {
  const token = env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN
  if (!token) {
    return {
      ok: false,
      error: 'POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN is not set, so there is nowhere to deliver polled mail.',
    }
  }
  let base = env.CRM_WEBHOOK_BASE_URL
  if (!base) {
    try {
      base = getAppUrl()
    } catch (err) {
      return { ok: false, error: `No forward base URL: ${err?.message || String(err)}` }
    }
  }
  const root = String(base).replace(/\/+$/, '')
  return {
    ok: true,
    url: `${root}${INBOUND_PATH}/${token}`,
    // 🔴 The token is NEVER logged. Every log line in this file uses this one.
    loggable: `${root}${INBOUND_PATH}/<token>`,
  }
}

/**
 * The text/plain and text/html parts that are this message's BODY.
 *
 * PURE. Two rules do the work:
 *
 *   • message/* IS NOT DESCENDED INTO. A forwarded .eml carries its own
 *     text/plain, and taking it would replace the covering note ("see below")
 *     with the forwarded message's body — the ticket would show the wrong
 *     text with no indication anything had been substituted. The attachment
 *     walker treats the same subtree as one file, so the two agree.
 *   • A part with a filename or an `attachment` disposition is a FILE even
 *     when it is text/plain (a .txt attachment, a .csv export). Those belong
 *     to imap-attachments.js, and reading one as the body would put a
 *     stranger's CSV in the ticket's message text.
 *
 * First match wins per type, which is the multipart/alternative convention
 * read the other way round: alternatives are ordered worst-to-best, but there
 * is only ever one text/plain and one text/html among them, so "first" and
 * "best" coincide.
 *
 * @returns {{text: {part: string}|null, html: {part: string}|null}}
 */
export function selectBodyParts(bodyStructure) {
  const found = { text: null, html: null }
  if (!bodyStructure || typeof bodyStructure !== 'object') return found

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const type = String(node.type || '').toLowerCase()

    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes || []) walk(child)
      return
    }
    // A container, not a body. See the rule above.
    if (type.startsWith('message/')) return

    const disposition = String(node.disposition || '').toLowerCase()
    const filename = node?.dispositionParameters?.filename || node?.parameters?.name || ''
    if (disposition === 'attachment' || (typeof filename === 'string' && filename.trim())) return

    // A single-part message's root node carries NO `part` (imapflow only sets
    // it once the walk is at least one level deep). RFC 3501 numbers the body
    // of a non-multipart message '1', which is also what imapflow's own
    // download() special-cases, so that is what we ask for.
    const part = node.part ? String(node.part) : '1'

    if (type === 'text/plain' && !found.text) found.text = { part }
    else if (type === 'text/html' && !found.html) found.html = { part }
  }

  walk(bodyStructure)
  return found
}

/**
 * Bytes → a string, honouring the part's charset.
 *
 * imapflow's download() converts a charset it recognises and rewrites
 * `meta.charset` to 'utf-8'. When it does not recognise one it leaves the
 * bytes alone, and THAT is the case this covers: a windows-1252 or
 * iso-8859-1 body read as UTF-8 turns every accented character in an Irish or
 * European name into mojibake, permanently, in the stored ticket.
 *
 * TextDecoder is Node's own (WHATWG encodings, no dependency). An unknown
 * label throws, and UTF-8 is the only honest fallback left.
 */
function decodeBodyBytes(buffer, charset) {
  const cs = typeof charset === 'string' ? charset.trim().toLowerCase() : ''
  if (cs && !['utf-8', 'utf8', 'us-ascii', 'usascii', 'ascii'].includes(cs)) {
    try {
      return new TextDecoder(cs).decode(buffer)
    } catch {
      // Unknown label — fall through to UTF-8 rather than lose the body.
    }
  }
  return buffer.toString('utf8')
}

/**
 * One body part, downloaded and decoded. Never throws; null means "no body
 * text from this part", which the mapper then reads as an absent body.
 *
 * download() rather than downloadMany() on purpose: it is the only imapflow
 * entry point that decodes the transfer encoding AND unwraps RFC 3676
 * format=flowed AND converts the charset AND honours maxBytes. Gmail sends
 * format=flowed plain text; without the unwrap, every soft line break becomes
 * a hard one in the stored ticket.
 */
async function downloadBodyPart(client, uid, part, ctx) {
  try {
    const res = await client.download(String(uid), part, { uid: true, maxBytes: MAX_BODY_PART_BYTES })
    const content = res?.content
    if (!content) return null

    const chunks = []
    let total = 0
    for await (const chunk of content) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buf)
      total += buf.length
      // Belt and braces over imapflow's own limiter: this loop is the thing
      // holding the memory, so it enforces its own ceiling rather than
      // trusting an option.
      if (total >= MAX_BODY_PART_BYTES) break
    }
    if (!chunks.length) return null
    return decodeBodyBytes(Buffer.concat(chunks), res?.meta?.charset)
  } catch (err) {
    // A body we could not download is NOT grounds to lose the email. The
    // message still files with its sender, subject, threading and
    // attachments, and this line is what says why the text is missing.
    logError('imap-poll', 'body part download failed', {
      mailboxId: ctx?.mailboxId, uid, part, err,
    })
    return null
  }
}

/**
 * 🔴 ATTACH THE DECODED BODIES TO THE MESSAGE BEFORE IT IS MAPPED.
 *
 * toInboundPayload() is pure and does not fetch: it reads `msg.text` /
 * `msg.html`. Call it without doing this first and every message becomes a
 * BLANK TICKET — no error, no log line, nothing on any screen except a
 * member's email with no words in it. This function is the whole reason
 * fetchSince() returns bodyStructure rather than bodies.
 *
 * Mutates `msg` (the imapflow object is ours for the duration of the tick) and
 * returns what it did.
 *
 * 🔴 THE RETURN VALUE IS NOT A COUNTER, IT IS A VERDICT, and the caller MUST
 * judge it (IMAP-BLANKBODY.1). It used to say "for the caller's counters" and
 * the caller discarded it entirely, which is how a body-part download failure
 * became permanent, silent data loss: downloadBodyPart() swallows every error
 * and returns null, so nothing throws, the mapper emits `TextBody: ''`, the
 * route files a blank ticket, answers 200, and the watermark advances past it.
 * It is unrecoverable — the synthetic MessageID is deterministic, so a re-POST
 * hits classifySeenClaim and comes back `200 deduped`, and the body can never
 * be back-filled. One dropped IMAP socket mid-backlog filed up to a full tick's
 * worth of member emails as empty tickets and moved the watermark past all of
 * them. See how pollOpenFolder() reads `attempted` against `text`/`html`.
 *
 * `attempted: 0` is a DIFFERENT verdict and not a failure: the message
 * genuinely has no text or html part (an attachments-only email is the normal
 * case). It is logged rather than silently filed, because the ticket will still
 * look empty to whoever opens it and that should be explicable.
 */
export async function attachBodies(client, msg, ctx) {
  const parts = selectBodyParts(msg?.bodyStructure)
  const out = { text: false, html: false, attempted: 0 }

  if (!parts.text && !parts.html) {
    logWarn('imap-poll', 'message carries no text or html body part — it will file with an empty body', {
      mailboxId: ctx?.mailboxId, uid: msg?.uid,
    })
    return out
  }

  if (parts.text) {
    out.attempted += 1
    const text = await downloadBodyPart(client, msg.uid, parts.text.part, ctx)
    if (text != null) {
      msg.text = text.length > MAX_TEXT_BODY_CHARS ? text.slice(0, MAX_TEXT_BODY_CHARS) : text
      out.text = true
    }
  }

  if (parts.html) {
    out.attempted += 1
    const html = await downloadBodyPart(client, msg.uid, parts.html.part, ctx)
    if (html != null) {
      msg.html = html.length > HTML_BODY_MAX_CHARS ? html.slice(0, HTML_BODY_MAX_CHARS) : html
      out.html = true
    }
  }

  return out
}

/**
 * 🔴 THE PAYLOAD, SERIALISED AND PROVEN TO FIT (IMAP-FORWARD-413.1).
 *
 * Serialising here rather than inside postInbound() is the point: the size is
 * a property of the BYTES, and the only way to know the bytes is to make them.
 * postInbound() is then handed the string it will send, so nothing is
 * serialised twice and nothing can be measured and then changed.
 *
 * Over budget, the BODIES are trimmed and nothing else. They are the only
 * fields large enough to matter, the route truncates them itself anyway
 * (truncateHtmlBody), and a ticket with a shortened body is one an operator can
 * still answer — where refusing the message outright, or letting it 413 and
 * stall the mailbox, are both silent losses. HTML goes first because the route
 * can derive plain text from it but not the reverse, so the plain text is the
 * half worth keeping.
 *
 * Halving rather than slicing to a computed length: the inflation factor
 * depends on the content (1 byte per ASCII character, 6 per control byte), so
 * there is no length to compute — a handful of halvings converges on any input
 * and terminates at an empty body.
 *
 * @returns {{ok: true, body: string, trimmed: boolean} | {ok: false, bytes: number}}
 *   `ok: false` means it does not fit even with both bodies emptied, which the
 *   per-field caps in imap-message.js should already make impossible. It is a
 *   floor, not an expected outcome, and the caller steps the message over
 *   loudly rather than POSTing something certain to be refused.
 */
export function enforceForwardBudget(payload) {
  let body = JSON.stringify(payload)
  if (Buffer.byteLength(body, 'utf8') <= MAX_FORWARD_BYTES) {
    return { ok: true, body, trimmed: false }
  }

  const trimmed = { ...payload }
  // At most ~40 halvings takes a 300k-character body to nothing, so the loop
  // is bounded by the data rather than by a guessed iteration count.
  while (Buffer.byteLength(body, 'utf8') > MAX_FORWARD_BYTES) {
    const html = typeof trimmed.HtmlBody === 'string' ? trimmed.HtmlBody : ''
    const text = typeof trimmed.TextBody === 'string' ? trimmed.TextBody : ''
    if (html.length > 0) trimmed.HtmlBody = html.length > 1 ? html.slice(0, Math.floor(html.length / 2)) : null
    else if (text.length > 0) trimmed.TextBody = text.length > 1 ? text.slice(0, Math.floor(text.length / 2)) : ''
    else return { ok: false, bytes: Buffer.byteLength(body, 'utf8') }
    body = JSON.stringify(trimmed)
  }
  return { ok: true, body, trimmed: true }
}

/**
 * POST one already-serialised payload at the inbound route and report what it
 * said.
 *
 * Never throws: a transport failure comes back as `status: 0`, which is not a
 * 2xx and is not in PERMANENT_REJECTION_STATUSES, so it takes the "halt without
 * advancing" branch and the next tick retries — the same outcome Postmark gets
 * from a Vercel timeout.
 *
 * @param {{url: string, loggable: string}} target
 * @param {string} payloadJson  the JSON produced by enforceForwardBudget().
 *   NOT named `body` — the RESPONSE body is already called that below, and the
 *   two colliding is a TDZ ReferenceError that reads at runtime as an
 *   unexplained `status: 0` on every single forward.
 */
async function postInbound(target, payloadJson) {
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Marks the hop for anyone reading Vercel logs, exactly as the Edge
        // shim's own header does. It carries NO authority — the route
        // authenticates on the URL token and nothing else.
        'x-un1t-producer': 'imap-poll',
      },
      body: payloadJson,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    let body = ''
    try {
      body = (await res.text()).slice(0, 300)
    } catch {
      // A body we cannot read changes nothing — the STATUS is the decision.
    }
    return { status: res.status, body }
  } catch (err) {
    return { status: 0, body: '', error: String(err?.message || err) }
  }
}

/**
 * Write the cursor row. Upsert, because cold start has no row yet.
 *
 * Never throws, and NEVER SILENTLY NO-OPS: a lost cursor write means the next
 * tick re-POSTs everything this one filed (harmless — the route dedupes) or,
 * on the failure path, that the backoff never engages. Both need to be visible.
 */
async function writeIngress(db, mailboxId, folder, patch, nowIso) {
  try {
    const { error } = await db
      .from('email_mailbox_ingress')
      .upsert(
        { mailbox_id: mailboxId, folder, updated_at: nowIso, ...patch },
        { onConflict: 'mailbox_id,folder' },
      )
    if (error) {
      logError('imap-poll', 'cursor write failed', { mailboxId, folder, err: error })
      return false
    }
    return true
  } catch (err) {
    logError('imap-poll', 'cursor write threw', { mailboxId, folder, err })
    return false
  }
}

/* ──────────────────────────── one mailbox ─────────────────────────────── */

/**
 * Poll one folder of one connected mailbox, end to end.
 *
 * 🔴 NEVER THROWS. Every exit is a verdict envelope. The multi-tenant loop
 * relies on that: a tenant whose password was revoked this morning must not be
 * able to take another tenant's poll down with them.
 *
 * @param {object} db  service-role Supabase client
 * @param {{id: string, address: string, location_id?: string}} mailbox  an
 *   email_mailboxes row with `ingress = 'imap'`
 * @param {object} [options]
 * @param {string} [options.folder='inbox']  the LANE, not the IMAP path
 * @param {number} [options.cap=25]  messages ingested this tick
 * @param {number} [options.now]  injectable clock, for tests
 * @param {string[]} [options.mailboxAddresses]  🔴 every active mailbox address
 *   in the estate, loaded once for the whole sweep. The ones that are not this
 *   mailbox's own are stripped from ToFull/CcFull so a forged `To:` cannot file
 *   this message into another tenant's inbox — see dropForeignMailboxes() in
 *   imap-message.js. Omitted, this mailbox loads its own copy; UNREADABLE, the
 *   poll is refused rather than run without the guard.
 * @param {number} [options.deadlineAt]  epoch ms after which no further message
 *   is started. Defaults to `clock() + budgetMs`, so a direct caller gets the
 *   guarantee too; pollAllMailboxes passes ONE deadline for the whole sweep.
 * @param {number} [options.budgetMs=DEFAULT_TICK_BUDGET_MS]
 * @param {() => number} [options.clock=Date.now]  real elapsed time, separate
 *   from `now` — `now` is a fixed timestamp a test pins, this one has to move.
 * @param {{createClient?: Function}} [options.deps]  the Wave 1 test seam,
 *   passed straight through to withMailbox(). Production callers pass nothing.
 * @returns {Promise<{ok: boolean, ingested: number, skipped: number, reason?: string, error?: string}>}
 */
export async function pollMailbox(db, mailbox, options = {}) {
  const {
    folder = DEFAULT_FOLDER,
    cap = DEFAULT_CAP,
    now = Date.now(),
    mailboxAddresses,
    clock = Date.now,
    budgetMs = DEFAULT_TICK_BUDGET_MS,
    deadlineAt = clock() + budgetMs,
    deps,
  } = options
  const nowIso = new Date(now).toISOString()

  const mailboxId = typeof mailbox?.id === 'string' ? mailbox.id : ''
  const mailboxAddress = typeof mailbox?.address === 'string' ? mailbox.address.trim() : ''
  if (!mailboxId || !mailboxAddress) {
    // Nothing to key a cursor row on, so there is nowhere to record this
    // either. Loud log, honest verdict.
    logError('imap-poll', 'refusing to poll a mailbox with no id or address', {
      mailboxId: mailboxId || null,
    })
    return { ok: false, ingested: 0, skipped: 0, reason: 'invalid_mailbox', error: 'Mailbox row has no id or address.' }
  }

  // ── Where does the mail go? Answered before anything is opened. ────
  const target = resolveInboundTarget()
  if (!target.ok) {
    // A deployment-level fault, not this mailbox's. It is recorded so the
    // settings card can say something, but it does NOT increment the failure
    // counter and does NOT pause: every connected mailbox in the estate hits
    // this at the same moment, and pausing them all for a day because an env
    // var was missing for ten minutes is exactly the silent stop this feature
    // exists to avoid.
    logError('imap-poll', 'no inbound target configured — refusing to poll', { mailboxId, err: target.error })
    await writeIngress(db, mailboxId, folder, { last_run_at: nowIso, last_error: target.error }, nowIso)
    return { ok: false, ingested: 0, skipped: 0, reason: 'not_configured', error: target.error }
  }

  // ── Which addresses are OURS? Answered before anything is opened. ──
  // 🔴 FAIL CLOSED HERE, and it is the narrow case that earns it. Without this
  // list a forged `To:` header files a member's email into a DIFFERENT
  // tenant's inbox — their location, their contacts, their staff — and deletes
  // it from the one it was addressed to, because the POST answers 2xx and the
  // watermark advances. Proceeding is actively harmful, irreversible and
  // cross-tenant; refusing costs one skipped tick, because the watermark does
  // not move and the next tick re-reads the same messages.
  //
  // Recorded like the missing-target fault above and for the same reason: an
  // unreadable email_mailboxes is an estate-wide fault, so it must NOT count
  // as this tenant's failure and must NOT pause them for a day.
  let foreignAddresses = mailboxAddresses
  if (!Array.isArray(foreignAddresses)) {
    const loaded = await loadActiveMailboxAddresses(db)
    if (!loaded.ok) {
      return await recordConfigFault(db, mailboxId, folder, {
        error: loaded.error, reason: 'address_set_unavailable', nowIso,
        log: 'could not read the estate mailbox addresses — refusing to poll rather than risk cross-tenant filing',
      })
    }
    foreignAddresses = loaded.addresses
  }

  // ── Credentials ───────────────────────────────────────────────────
  let credential = null
  try {
    const { data, error } = await db
      .from('email_mailbox_credentials')
      .select(CREDENTIAL_COLUMNS)
      .eq('mailbox_id', mailboxId)
      .maybeSingle()
    if (error) {
      logError('imap-poll', 'credential lookup failed', { mailboxId, err: error })
      return await recordFailure(db, mailboxId, folder, {
        kind: 'transport',
        error: `Could not read the stored credential: ${error.message}`,
        reason: 'credential_lookup_failed',
        nowIso, now,
      })
    }
    credential = data
  } catch (err) {
    logError('imap-poll', 'credential lookup threw', { mailboxId, err })
    return await recordFailure(db, mailboxId, folder, {
      kind: 'transport', error: safeErrorText(err), reason: 'credential_lookup_failed', nowIso, now,
    })
  }

  const verdict = resolveAuth(credential)
  if (!verdict.ok) {
    // 🔴 A DEPLOYMENT FAULT IS NOT A TENANT'S FAULT (IMAP-CONFIGPAUSE.1).
    //
    // resolveAuth answers `not_configured` for two completely different things:
    // "this mailbox has no credential stored" — a real per-mailbox operator
    // action, which earns the auth curve — and "MAILBOX_SECRET_KEY is absent
    // from this deployment", which is an env var nobody set. The second one
    // hits EVERY connected mailbox in the estate at the same instant, and
    // feeding it to the auth backoff paused every tenant on a 30min→24h curve
    // for a fault that is fixed by one redeploy. The authors had already
    // reasoned this out thirty lines above for the inbound target ("it does NOT
    // increment the failure counter and does NOT pause"); this is the same
    // shape and gets the same answer.
    //
    // Told apart by asking secret-box directly rather than by matching
    // resolveAuth's sentence: the string is theirs to reword, the predicate is
    // not.
    if (verdict.reason === 'not_configured' && !isConfigured()) {
      return await recordConfigFault(db, mailboxId, folder, {
        error: verdict.error, reason: verdict.reason, nowIso,
        log: 'mailbox encryption is not configured on this deployment — refusing to poll, and NOT pausing',
      })
    }
    // Everything else resolveAuth reports is a per-mailbox operator action (no
    // credential, wrong key, expired token), so it takes the auth curve — and
    // its `error` is a constant sentence written for a person, which is why it
    // is stored verbatim.
    return await recordFailure(db, mailboxId, folder, {
      kind: 'auth', error: verdict.error, reason: verdict.reason, nowIso, now,
    })
  }
  const auth = verdict.auth

  const folderPath = folderPathFor(folder, credential)
  if (!folderPath) {
    // Configuration, not authentication. No number of retries resolves it and
    // no pause helps: nothing will succeed until an operator names a folder, so
    // counting it as a consecutive failure only buries the mailbox under a
    // 24-hour auth pause for a fault that was never about credentials.
    const error = `No IMAP folder is configured for the '${folder}' lane on this mailbox.`
    return await recordConfigFault(db, mailboxId, folder, {
      error, reason: 'no_folder', nowIso,
      log: 'no IMAP folder is configured for this lane — refusing to poll, and NOT pausing',
    })
  }

  // ── The cursor ────────────────────────────────────────────────────
  let cursor = null
  try {
    const { data, error } = await db
      .from('email_mailbox_ingress')
      .select(INGRESS_COLUMNS)
      .eq('mailbox_id', mailboxId)
      .eq('folder', folder)
      .maybeSingle()
    if (error) {
      // 🔴 Do NOT proceed on an unreadable cursor. A missing row means cold
      // start (anchor, ingest nothing); a row we could not READ means the
      // watermark is unknown, and polling on an unknown watermark is how a
      // mailbox gets re-ingested from UID 1.
      logError('imap-poll', 'cursor lookup failed', { mailboxId, folder, err: error })
      return await recordFailure(db, mailboxId, folder, {
        kind: 'transport', error: `Could not read the poll cursor: ${error.message}`,
        reason: 'cursor_lookup_failed', nowIso, now,
      })
    }
    cursor = data
  } catch (err) {
    logError('imap-poll', 'cursor lookup threw', { mailboxId, folder, err })
    return await recordFailure(db, mailboxId, folder, {
      kind: 'transport', error: safeErrorText(err), reason: 'cursor_lookup_failed', nowIso, now,
    })
  }

  // ── Paused? ───────────────────────────────────────────────────────
  const pausedUntil = cursor?.paused_until ? Date.parse(cursor.paused_until) : NaN
  if (Number.isFinite(pausedUntil) && pausedUntil > now) {
    // Not an error and not a success — the tick did the right thing by not
    // hammering a mailbox that has told us it is broken. `ok: true` keeps one
    // paused tenant out of the cron's failure count; `paused_until` and
    // `last_error` are what the operator sees.
    return { ok: true, ingested: 0, skipped: 0, reason: 'paused' }
  }

  const storedUidValidity = toUidNumber(cursor?.uidvalidity)
  const storedLastUid = toUidNumber(cursor?.last_uid)

  // ── Connect and poll ──────────────────────────────────────────────
  const config = {
    host: credential.imap_host,
    port: credential.imap_port,
    secure: credential.imap_secure,
    auth,
  }

  // How many consecutive ticks this mailbox has made NO progress on. It is the
  // input to the deferral escape in pollOpenFolder(); see MAX_STALL_TICKS.
  const stalledTicks = Number(cursor?.consecutive_failures) || 0

  let run
  try {
    run = await withMailbox(config, folderPath, async (client, box) => (
      pollOpenFolder({
        db, client, box, mailboxId, mailboxAddress, foreignAddresses,
        cap, target, storedUidValidity, storedLastUid,
        stalledTicks, deadlineAt, clock,
      })
    ), deps)
  } catch (err) {
    const kind = classifyImapFailure(err)
    // 🔴 TWO DIFFERENT AUDIENCES, AND ONLY ONE OF THEM GETS THE SERVER'S WORDS.
    //
    // `last_error` is rendered on the settings card, which a customer-tier
    // OWNER can read. safeErrorText redacts our credentials but passes
    // `err.responseText` — the remote server's own bytes — straight through.
    // MAILBOX-CONNECT.8 closed the same oracle on the connect-verify route by
    // classifying instead of echoing; leaving it open here just makes the
    // poller the slower way to ask the same question. The stored host was
    // proven public at PUT time, but a name that resolves publicly once and
    // internally later (DNS rebinding) is exactly the residual that route
    // could not close on its own, and this is where the answer would surface.
    //
    // So: the OPERATOR gets a category they can act on, and the LOG gets the
    // detail an engineer needs. Nothing is lost — it is written down, just not
    // on a screen that turns it into a probe result.
    logError('imap-poll', 'poll failed', {
      mailboxId, folder, kind, err: { message: safeErrorText(err, auth) },
    })
    return await recordFailure(db, mailboxId, folder, {
      kind,
      error: operatorFacingDialError(kind),
      reason: kind === 'auth' ? 'auth_failed' : 'connect_failed',
      nowIso,
      now,
    })
  }

  // ── Record the outcome ────────────────────────────────────────────
  const patch = {
    last_run_at: nowIso,
    uidvalidity: run.uidValidity ?? storedUidValidity ?? null,
  }
  // The watermark moves to the last message the ROUTE ACCEPTED, and no
  // further. `advancedTo` is null when nothing was accepted, which leaves the
  // stored value exactly where it was.
  if (run.advancedTo != null) patch.last_uid = run.advancedTo

  if (run.halted) {
    // Partial success is still a failure of this tick: some mail is filed, the
    // rest is behind something that did not complete. `last_ok_at` deliberately
    // does NOT move — it is the health signal, and a mailbox that cannot
    // deliver is not healthy — while `last_uid` keeps whatever it earned.
    //
    // 🔴 `consecutive_failures` is not only the backoff counter, it is the
    // input to the stall escape (MAX_STALL_TICKS). That is why it counts ticks
    // that made NO further progress: the message it is counting against is the
    // one at the head of the queue, and it only changes when the watermark
    // moves — which is exactly when a successful tick resets this to 0 below.
    const kind = 'transport'
    const failures = (Number(cursor?.consecutive_failures) || 0) + 1
    const pause = backoffMs(kind, failures)
    patch.last_error = run.halted.error
    patch.consecutive_failures = failures
    patch.paused_until = pause > 0 ? new Date(now + pause).toISOString() : null
    await writeIngress(db, mailboxId, folder, patch, nowIso)
    // `status: 0` covers both a transport failure at the forward hop AND a
    // message whose body would not download — in both cases nothing was
    // recorded downstream and the watermark is held, which is the decision the
    // line is reporting. `last_error` carries which one it was.
    logError('imap-poll', 'a message could not be delivered onward — watermark held', {
      mailboxId, folder, forward: target.loggable, status: run.halted.status,
      ingested: run.ingested, error: run.halted.error,
    })
    return {
      ok: false, ingested: run.ingested, skipped: run.skipped,
      reason: 'forward_failed', error: run.halted.error,
    }
  }

  patch.last_ok_at = nowIso
  patch.last_error = null
  patch.consecutive_failures = 0
  patch.paused_until = null
  await writeIngress(db, mailboxId, folder, patch, nowIso)

  if (run.reason === 'cold_start' || run.reason === 'uidvalidity_changed') {
    logInfo('imap-poll', run.reason === 'cold_start'
      ? 'anchored a new mailbox — new mail only from here'
      : 'UIDVALIDITY changed — re-anchored without re-ingesting', {
      mailboxId, folder, uidValidity: run.uidValidity, lastUid: run.advancedTo,
    })
  } else if (run.ingested > 0 || run.skipped > 0) {
    logInfo('imap-poll', 'polled', {
      mailboxId, folder, ingested: run.ingested, skipped: run.skipped, lastUid: run.advancedTo,
    })
  }

  return { ok: true, ingested: run.ingested, skipped: run.skipped, ...(run.reason ? { reason: run.reason } : {}) }
}

/**
 * Everything that happens with the folder open. Split out so pollMailbox()
 * reads as the decision it is (credentials → cursor → connect → record) and so
 * the three anchoring outcomes are visible side by side.
 *
 * @returns {Promise<{ingested: number, skipped: number, advancedTo: number|null,
 *                    uidValidity: number|null, reason?: string,
 *                    halted?: {status: number, error: string}}>}
 */
async function pollOpenFolder({
  db, client, box, mailboxId, mailboxAddress, foreignAddresses, cap, target,
  storedUidValidity, storedLastUid, stalledTicks = 0, deadlineAt = null, clock = Date.now,
}) {
  const uidValidity = toUidNumber(box?.uidValidity)
  const uidNext = toUidNumber(box?.uidNext)
  // uidNext is "the UID the next message will get", so the highest UID that
  // can exist right now is one below it. An empty mailbox reports uidNext 1,
  // which anchors at 0 — a legal cursor that fetchSince() accepts.
  const highestUid = uidNext != null && uidNext >= 1 ? uidNext - 1 : null

  const anchor = (reason) => {
    if (highestUid == null) {
      // 🔴 FAIL CLOSED, and this is the narrow case that earns it. Anchoring
      // at 0 without a trustworthy uidNext would make the NEXT tick fetch
      // `1:*` and file the customer's entire mailbox as fresh tickets, with
      // push notifications — the one outcome §3.5 forbids outright. Proceeding
      // is actively harmful and irreversible; refusing costs one skipped tick.
      throw new Error('Server reported no usable UIDNEXT, so the mailbox cannot be anchored safely.')
    }
    return { ingested: 0, skipped: 0, advancedTo: highestUid, uidValidity, reason }
  }

  // Cold start (§3.5) — anchor and ingest NOTHING. `last_uid` NULL is the only
  // marker of "never anchored"; a row with a uidvalidity but no last_uid is
  // the same thing (the write is one statement, but a half-written row must
  // not read as a watermark).
  if (storedLastUid == null || storedUidValidity == null) return anchor('cold_start')

  // UIDVALIDITY changed (§3.3) — every UID we hold now names a different
  // message, or none. Re-anchor. NEVER replay: re-ingesting would file the
  // whole mailbox again, and the RFC Message-ID dedupe would only save us for
  // messages we had already seen.
  if (uidValidity != null && uidValidity !== storedUidValidity) return anchor('uidvalidity_changed')

  const messages = await fetchSince(client, { sinceUid: storedLastUid, cap })
  if (messages.length === 0) {
    return { ingested: 0, skipped: 0, advancedTo: null, uidValidity }
  }

  let ingested = 0
  let skipped = 0
  let advancedTo = null
  let budgetStopped = false

  // ── The stall escape (see MAX_STALL_TICKS) ───────────────────────
  // `stalled` says this mailbox has been failing on the same head-of-line
  // message for the better part of a day. In that state the FIRST retryable
  // refusal is not accepted at face value: the message is held back as
  // `deferred` and the NEXT one is posted as a probe.
  //
  //   • the probe gets a 2xx  → the forward path demonstrably works, so the
  //     held-back message is deterministically unforwardable. Dead-letter it
  //     loudly, discard its staged bytes, and let the watermark move past it.
  //   • the probe gets anything else → this is an outage, not a poison
  //     message. Halt with the watermark exactly where it started; nothing is
  //     lost and nothing was stepped over on a guess.
  //
  // 🔴 While a deferral is unresolved NOTHING may advance the watermark, or
  // the held-back message would be jumped without the proof that justifies it.
  // Every advance below is therefore inside `if (!deferred)` except the 2xx
  // branch, which resolves the deferral first.
  const stalled = stalledTicks >= MAX_STALL_TICKS
  let deferred = null

  const halt = (status, error) => ({
    ingested,
    skipped,
    advancedTo,
    uidValidity,
    halted: { status, error: String(error).slice(0, MAX_ERROR_CHARS) },
  })

  for (const msg of messages) {
    // ── The wall-clock budget (see DEFAULT_TICK_BUDGET_MS) ─────────
    // Checked between messages, never mid-message: a half-forwarded message is
    // not a thing this design has a state for. Stopping here is CLEAN — the
    // watermark keeps every message the route accepted, the tick counts as
    // healthy, and the rest are still in the mailbox for the next one.
    if (deadlineAt != null && clock() >= deadlineAt) {
      budgetStopped = true
      logWarn('imap-poll', 'tick budget spent — stopping this mailbox cleanly, the rest carries to the next tick', {
        mailboxId, ingested, skipped, remaining: messages.length - (ingested + skipped),
      })
      break
    }

    const uid = toUidNumber(msg?.uid)

    /** Step over one message. Inert while a deferral is unresolved. */
    const stepOver = () => {
      skipped += 1
      if (!deferred) advancedTo = uid ?? advancedTo
    }

    let payload
    try {
      // 🔴 BODIES FIRST. See attachBodies() — the mapper does not fetch, and a
      // payload built before this call files a blank ticket in silence.
      const bodies = await attachBodies(client, msg, { mailboxId })

      // 🔴 A BODY WE TRIED AND FAILED TO DOWNLOAD IS NOT A BLANK TICKET
      // (IMAP-BLANKBODY.1). downloadBodyPart() returns null on any error, so
      // without this the message files with `TextBody: ''`, the route answers
      // 200, the watermark advances — and the body can NEVER be back-filled,
      // because the deterministic MessageID makes every re-POST a
      // `200 deduped`. Holding the tick costs five minutes and loses nothing:
      // the watermark does not move, so the next tick downloads it again.
      //
      // `attempted > 0` with neither half present is the only failing shape.
      // One half arriving is enough for a ticket somebody can answer, and
      // `attempted: 0` means the message genuinely has no body part (already
      // logged inside attachBodies).
      if (bodies.attempted > 0 && !bodies.text && !bodies.html) {
        if (!stalled) {
          logError('imap-poll', 'could not download any body part — holding the watermark rather than filing a blank ticket', {
            mailboxId, uid, attempted: bodies.attempted,
          })
          return halt(0, 'Could not download the message body; the watermark is held so the next tick retries.')
        }
        // Bounded, for the same reason the deferral above is bounded: a body
        // part that fails EVERY time would otherwise stall the mailbox
        // permanently, which is the denial-of-inbox this file spends its
        // length avoiding. A blank ticket carrying the real sender, subject,
        // threading and attachments is poor; no ticket at all, and no further
        // mail ever, is worse.
        logError('imap-poll', '🔴 FILING WITHOUT ITS BODY after repeated failed ticks — the ticket will be blank', {
          mailboxId, uid, stalledTicks, attempted: bodies.attempted,
        })
      }

      payload = toInboundPayload(msg, { mailboxAddress, mailboxId, foreignAddresses })
    } catch (err) {
      // Neither call is supposed to throw. If one does it is a bug in ours,
      // and a bug must not stall a mailbox: log it with the UID and step over.
      logError('imap-poll', 'could not prepare a message — stepping over it', { mailboxId, uid, err })
      stepOver()
      continue
    }

    if (!payload.MessageID) {
      // The mapper returns null only when the message has neither an RFC
      // Message-ID nor a usable UID, which fetchSince() should make
      // impossible. The route would answer 400 forever, so this steps over —
      // loudly, naming the UID, because a message we cannot identify is one
      // somebody may have to fetch out of the mailbox by hand.
      logError('imap-poll', 'message has no usable id — cannot be deduped, stepping over it', { mailboxId, uid })
      stepOver()
      continue
    }

    // Boundary assertions, both against the OWNING module's own contract
    // rather than a copied regex. If the synthetic-id format ever drifts out
    // of the Storage path alphabet this says so at the source, once per
    // message, instead of degrading every attachment in the estate to
    // `rehost_failed` quietly.
    if (!SYNTHETIC_ID_RE.test(payload.MessageID) || !canStageForMessage(payload.MessageID)) {
      logError('imap-poll', 'synthetic MessageID is not a safe Storage path segment — attachments on this message cannot be staged', {
        mailboxId, uid, messageId: payload.MessageID,
      })
    }

    // stageImapAttachments never throws and never costs the email: an
    // unusable id, an oversized part or a failed upload each come back as an
    // entry the route records as skipped, so the file is ON the ticket rather
    // than absent from it.
    const staged = await stageImapAttachments(db, client, msg, { mailboxId, messageId: payload.MessageID })
    payload.Attachments = staged.attachments
    if (staged.skipped.length > 0) {
      logWarn('imap-poll', 'some attachments were not stored', {
        mailboxId, uid, skipped: staged.skipped,
      })
    }

    /**
     * Delete this message's staged bytes. Mirrors the `unfiled` wrapper the
     * route wraps every not-being-filed exit in: past this point the bytes are
     * in a metered bucket with nothing that will ever name them. NOT called on
     * the halt paths — those retry, and the staged path is deterministic, so
     * the retry overwrites rather than accumulating (the route's own residue
     * note says the same).
     */
    const dropStagedBytes = () => discardStagedAttachments(db, payload.Attachments, {
      postmarkMessageId: payload.MessageID,
    })

    // The measured budget, and the last thing between us and a plain-text 413.
    const wire = enforceForwardBudget(payload)
    if (!wire.ok) {
      logError('imap-poll', 'payload will not fit the forward budget even with its bodies emptied — stepping over it', {
        mailboxId, uid, bytes: wire.bytes,
      })
      await dropStagedBytes()
      stepOver()
      continue
    }
    if (wire.trimmed) {
      logWarn('imap-poll', 'trimmed the message bodies to fit the forward budget', { mailboxId, uid })
    }

    const res = await postInbound(target, wire.body)

    if (res.status >= 200 && res.status < 300) {
      if (deferred) {
        // 🔴 THE PROOF. The route just accepted a different message over the
        // same hop, so the held-back one is not an outage — it is a message
        // this pipeline cannot forward, and it has already had MAX_STALL_TICKS
        // worth of ticks to prove otherwise. Dead-letter it: loud, named by
        // UID and status, so it can be read out of the mailbox by hand.
        logError('imap-poll', '🔴 DEAD-LETTERED: the inbound route accepted the NEXT message, so this one is permanently unforwardable and is being stepped over', {
          mailboxId, uid: deferred.uid, status: deferred.status, body: deferred.body,
          forward: target.loggable, stalledTicks,
        })
        await deferred.dropStagedBytes()
        skipped += 1
        deferred = null
      }
      // 🔴 THE ONLY PLACE THE WATERMARK MOVES ON AN INGESTED MESSAGE.
      ingested += 1
      advancedTo = uid ?? advancedTo
      continue
    }

    if (PERMANENT_REJECTION_STATUSES.has(res.status)) {
      // See PERMANENT_REJECTION_STATUSES. Retrying is guaranteed to fail
      // identically, so the choice is between stepping over one message and
      // losing every message behind it. The staged bytes go with it — the
      // route's own 400s are raised in POST, before processInboundEmail's
      // `unfiled` wrapper exists, so nothing downstream sweeps them.
      //
      // Reached with a deferral open too, and stepOver() is inert there on
      // purpose: the probe simply moves on to the message after this one. A
      // permanent rejection is no proof the route is HEALTHY (a 413 is raised
      // by the platform before the function even runs), so it may not be
      // allowed to resolve a deferral — but neither may it halt the probe, or
      // one poison message followed by one unrepresentable one would stall the
      // mailbox forever between them.
      logError('imap-poll', 'inbound route permanently refused a message — stepping over it', {
        mailboxId, uid, forward: target.loggable, status: res.status, body: res.body,
      })
      await dropStagedBytes()
      stepOver()
      continue
    }

    // A retryable refusal — 5xx, 503 claim_in_flight, a 404 from a wrong
    // token, a timeout. The route did NOT record this message.
    if (!deferred && stalled && ingested === 0 && advancedTo === null) {
      // Nothing has moved this tick and nothing has moved for MAX_STALL_TICKS
      // ticks, so this message is the one blocking the mailbox. Hold it back
      // and probe the next one rather than halting again into the same wall.
      deferred = { uid, status: res.status, body: res.body, dropStagedBytes }
      logWarn('imap-poll', 'mailbox has been stalled on this message for many ticks — holding it back and probing the next one', {
        mailboxId, uid, status: res.status, stalledTicks,
      })
      continue
    }

    // Halt. The watermark stays behind the earliest unaccepted message and the
    // whole mailbox stops for this tick: every later message would have to
    // jump the cursor over this one to be filed at all. When a deferral is
    // open, `advancedTo` is still null by construction, so halting here also
    // un-defers safely — the held-back message is simply retried next tick.
    return halt(
      res.status,
      `Inbound route answered ${res.status || 'no response'}${res.error ? `: ${res.error}` : ''}`,
    )
  }

  if (deferred) {
    // The loop ran out of messages before the probe could prove anything (the
    // held-back message was the last one). Halt: no proof, no step-over.
    return halt(deferred.status, `Inbound route answered ${deferred.status || 'no response'}`)
  }

  return {
    ingested,
    skipped,
    advancedTo,
    uidValidity,
    ...(budgetStopped ? { reason: 'budget_stopped' } : {}),
  }
}

/**
 * Record a CONFIGURATION fault: visible, but not counted and not paused.
 *
 * 🔴 The distinction recordFailure() cannot make. A missing env var, an
 * unreadable estate-wide table or a lane with no folder configured are all
 * faults that NO amount of retrying fixes and that pausing actively harms:
 * the first two hit every connected mailbox in the estate at the same instant,
 * so feeding them to the auth curve parks every tenant for up to 24 hours over
 * a deployment mistake that takes ten minutes to correct. The third is a
 * static per-mailbox setting — a pause adds nothing an operator can act on.
 *
 * So the row still says what is wrong (`last_error` is what the settings card
 * renders), and `consecutive_failures` / `paused_until` are left alone. This is
 * the same reasoning the inbound-target check applies at the top of
 * pollMailbox(), factored out so the three paths cannot drift apart.
 */
async function recordConfigFault(db, mailboxId, folder, { error, reason, nowIso, log }) {
  logError('imap-poll', log, { mailboxId, folder, reason, err: error })
  await writeIngress(db, mailboxId, folder, { last_run_at: nowIso, last_error: error }, nowIso)
  return { ok: false, ingested: 0, skipped: 0, reason, error }
}

/**
 * Record a failure against the cursor row and return the verdict.
 *
 * One place, so that every failure path increments the same counter, takes the
 * right backoff curve and leaves an operator-readable `last_error`.
 */
async function recordFailure(db, mailboxId, folder, { kind, error, reason, nowIso, now }) {
  let failures = 1
  try {
    // maybeSingle, not single: on a cold-start failure there is genuinely no
    // row yet, and that is a legitimate answer rather than an error.
    const { data, error } = await db
      .from('email_mailbox_ingress')
      .select('consecutive_failures')
      .eq('mailbox_id', mailboxId)
      .eq('folder', folder)
      .maybeSingle()
    if (error) logWarn('imap-poll', 'could not read the failure counter — restarting it at 1', { mailboxId, folder, err: error })
    else failures = (Number(data?.consecutive_failures) || 0) + 1
  } catch (err) {
    // A counter we could not read starts at 1. The alternative — refusing to
    // record the failure at all — would leave the operator with no signal at
    // all, which is strictly worse than a backoff that restarts.
    logWarn('imap-poll', 'reading the failure counter threw — restarting it at 1', { mailboxId, folder, err })
  }

  const pause = backoffMs(kind, failures)
  await writeIngress(db, mailboxId, folder, {
    last_run_at: nowIso,
    last_error: error,
    consecutive_failures: failures,
    paused_until: pause > 0 ? new Date(now + pause).toISOString() : null,
  }, nowIso)

  logWarn('imap-poll', kind === 'auth'
    ? 'mailbox authentication failed — operator action needed'
    : 'mailbox poll failed', { mailboxId, folder, reason, failures, pausedForMs: pause })

  return { ok: false, ingested: 0, skipped: 0, reason, error }
}

/* ─────────────────────────── every mailbox ────────────────────────────── */

/**
 * Poll every connected mailbox once.
 *
 * 🔴 THE MULTI-TENANT GUARANTEE LIVES HERE (5.3). Three properties, and each
 * one is a thing that has bitten a sweep in this codebase before:
 *
 *   • BOUNDED CONCURRENCY. Mailboxes run through a pool of POLL_CONCURRENCY
 *     rather than sequentially (one slow host would eat the whole 5-minute
 *     budget and starve everyone behind it) and rather than all at once (N
 *     simultaneous IMAP sessions plus N POSTs at our own webhook is a
 *     self-inflicted thundering herd).
 *   • PER-MAILBOX CONTAINMENT. pollMailbox() never throws, and
 *     mapWithConcurrency() catches anyway. One tenant's revoked password is a
 *     counter in the summary, never an aborted sweep.
 *   • FAIR ORDERING. Oldest `last_run_at` first, never-polled first of all, so
 *     a mailbox cannot be starved by another that happens to sort earlier.
 *
 * @returns {Promise<{ok: boolean, mailboxes: number, ingested: number,
 *                    skipped: number, failed: number, paused: number, reason?: string}>}
 */
export async function pollAllMailboxes(db, options = {}) {
  const {
    folder = DEFAULT_FOLDER,
    cap = DEFAULT_CAP,
    concurrency = POLL_CONCURRENCY,
    now = Date.now(),
    clock = Date.now,
    budgetMs = DEFAULT_TICK_BUDGET_MS,
    deps,
  } = options

  // ONE deadline for the whole sweep, taken before any work. Per-mailbox
  // budgets would multiply by the number of tenants, which is the starvation
  // this is here to prevent.
  const deadlineAt = clock() + budgetMs

  const listed = await loadPollableMailboxes(db)
  if (!listed.ok) {
    return { ok: false, mailboxes: 0, ingested: 0, skipped: 0, failed: 0, paused: 0, reason: 'mailbox_lookup_failed' }
  }
  const mailboxes = listed.mailboxes

  // Dormant is the normal state until an operator connects a login in Phase 6,
  // and a dormant tick is a healthy tick — it still stamps the heartbeat.
  if (mailboxes.length === 0) {
    return { ok: true, mailboxes: 0, ingested: 0, skipped: 0, failed: 0, paused: 0 }
  }

  // 🔴 The estate's address list, read ONCE for the sweep rather than once per
  // mailbox: it is the same answer for every tenant, and re-reading it N times
  // per tick would be the one query in this file that scales with tenants. If
  // it cannot be read, NOTHING is polled — see the fail-closed reasoning in
  // pollMailbox(); a poll without it can file a member's email into another
  // tenant's inbox on a forged header.
  const addresses = await loadActiveMailboxAddresses(db)
  if (!addresses.ok) {
    logError('imap-poll', 'could not read the estate mailbox addresses — refusing the whole sweep', { err: addresses.error })
    return { ok: false, mailboxes: 0, ingested: 0, skipped: 0, failed: 0, paused: 0, reason: 'address_set_unavailable' }
  }

  // 🔴 ORDER FIRST, CUT SECOND. Cutting first is what made the old
  // `.limit(200)` a starvation bug rather than a bound — see
  // MAX_MAILBOXES_PER_TICK.
  const ordered = (await orderByLastRun(db, mailboxes, folder)).slice(0, MAX_MAILBOXES_PER_TICK)
  if (mailboxes.length > MAX_MAILBOXES_PER_TICK) {
    logWarn('imap-poll', 'more connected mailboxes than one tick polls — the least-recently-run were taken, the rest lead the next tick', {
      ceiling: MAX_MAILBOXES_PER_TICK, connected: mailboxes.length,
    })
  }

  const results = await mapWithConcurrency(ordered, concurrency, (mailbox) => {
    // Checked between mailboxes as well as between messages: one slow tenant
    // must not be able to spend a later tenant's share of the budget, and a
    // mailbox that is never STARTED costs nothing and sorts to the front of
    // the next tick (its `last_run_at` did not move).
    if (clock() >= deadlineAt) {
      return { ok: true, ingested: 0, skipped: 0, reason: 'budget_exhausted' }
    }
    return pollMailbox(db, mailbox, {
      folder, cap, now, deps, clock, deadlineAt,
      mailboxAddresses: addresses.addresses,
    })
  })

  const summary = { ok: true, mailboxes: ordered.length, ingested: 0, skipped: 0, failed: 0, paused: 0 }
  let unstarted = 0
  for (const result of results) {
    // mapWithConcurrency's own catch. pollMailbox() is written never to reach
    // it; if it ever does, the sweep still finishes and the count still says so.
    if (!result?.ok) {
      summary.failed += 1
      continue
    }
    const verdict = result.value
    summary.ingested += Number(verdict?.ingested) || 0
    summary.skipped += Number(verdict?.skipped) || 0
    if (verdict?.reason === 'paused') summary.paused += 1
    else if (verdict?.reason === 'budget_exhausted') unstarted += 1
    else if (verdict?.ok === false) summary.failed += 1
  }

  // Not a summary field — the shape is pinned and read by the cron. A tick
  // that ran out of clock is healthy, but it must not be INVISIBLE: a sweep
  // silently leaving half the estate unpolled every tick is the shape that
  // hides a slow tenant.
  if (unstarted > 0) {
    logWarn('imap-poll', 'tick budget spent before every mailbox was started — they lead the next tick', {
      unstarted, mailboxes: ordered.length, budgetMs,
    })
  }

  return summary
}

/**
 * Every connected IMAP mailbox, range-paginated with an explicit order.
 *
 * 🔴 The 1,000-row cap invariant, applied. A `.select()` returns at most 1000
 * rows whatever `.limit()` says, and PostgREST's physical order is stable, so
 * an unordered `.limit(N)` hands back THE SAME N every tick — the rows past it
 * are not "polled later", they are never polled at all. Ordering by `id` makes
 * the pages disjoint and complete; the FAIR ordering (least-recently-run) is a
 * separate step over the full set, which is the only order that can honour the
 * "a mailbox cannot be starved" guarantee.
 *
 * @returns {Promise<{ok: true, mailboxes: object[]} | {ok: false}>}
 */
async function loadPollableMailboxes(db) {
  const mailboxes = []
  try {
    for (let from = 0; from < MAX_MAILBOXES_SCANNED; from += MAILBOX_PAGE_SIZE) {
      const { data, error } = await db
        .from('email_mailboxes')
        .select(POLL_MAILBOX_COLUMNS)
        .eq('ingress', 'imap')
        .eq('active', true)
        .order('id', { ascending: true })
        .range(from, from + MAILBOX_PAGE_SIZE - 1)
      if (error) {
        logError('imap-poll', 'could not list connected mailboxes', { err: error, from })
        return { ok: false }
      }
      const page = Array.isArray(data) ? data : []
      mailboxes.push(...page)
      // A short page is the last page. Anything else would re-request the same
      // rows forever on a backend that ignores `range`.
      if (page.length < MAILBOX_PAGE_SIZE) return { ok: true, mailboxes }
    }
  } catch (err) {
    logError('imap-poll', 'listing connected mailboxes threw', { err })
    return { ok: false }
  }
  logWarn('imap-poll', 'hit the mailbox scan ceiling — the fair ordering below is over a partial set', {
    ceiling: MAX_MAILBOXES_SCANNED,
  })
  return { ok: true, mailboxes }
}

/**
 * 🔴 EVERY ACTIVE MAILBOX ADDRESS IN THE ESTATE — the cross-tenant guard's
 * input (IMAP-ROUTE-FORGE.1).
 *
 * ACTIVE, not all: `resolveMailboxByRecipient` only ever resolves an active
 * mailbox, so a deactivated address cannot steal a message and dropping it
 * would silently delete a real recipient from `to_emails` for no benefit. That
 * is deliberately the OPPOSITE choice to loadOwnAddresses(), which is unscoped
 * because it answers a different question (what may we reply-all TO).
 *
 * Estate-wide and unscoped by location, because the webhook's own mailbox
 * lookup is estate-wide — a guard narrower than the thing it guards is not a
 * guard. The addresses are used ONLY as an exclusion set and never leave this
 * process.
 *
 * @returns {Promise<{ok: true, addresses: string[]} | {ok: false, error: string}>}
 */
async function loadActiveMailboxAddresses(db) {
  const addresses = []
  try {
    for (let from = 0; from < MAX_MAILBOXES_SCANNED; from += MAILBOX_PAGE_SIZE) {
      const { data, error } = await db
        .from('email_mailboxes')
        .select('id, address')
        .eq('active', true)
        .order('id', { ascending: true })
        .range(from, from + MAILBOX_PAGE_SIZE - 1)
      if (error) {
        return { ok: false, error: `Could not read the estate mailbox addresses: ${error.message}` }
      }
      const page = Array.isArray(data) ? data : []
      for (const row of page) {
        if (typeof row?.address === 'string' && row.address.trim()) addresses.push(row.address.trim())
      }
      if (page.length < MAILBOX_PAGE_SIZE) return { ok: true, addresses }
    }
  } catch (err) {
    return { ok: false, error: `Reading the estate mailbox addresses threw: ${err?.message || String(err)}` }
  }
  // A truncated set is a HOLE IN THE GUARD, not a smaller guard: the addresses
  // past the ceiling would be forgeable again. Refuse rather than half-protect.
  return {
    ok: false,
    error: `More than ${MAX_MAILBOXES_SCANNED} mailboxes: the cross-tenant address guard cannot be built completely, so polling is refused.`,
  }
}

/**
 * Mailboxes in fair order: never polled first, then oldest attempt first.
 *
 * One small query for the whole sweep — the cursor rows are re-read inside
 * pollMailbox(), which is deliberate. Passing them in would couple the loop to
 * the row shape and give pollMailbox() a cursor it did not read for itself,
 * and the cursor is the one value in this feature that must never be second
 * hand. One extra SELECT of a handful of rows per tick is the right price.
 *
 * A failed ordering read is NOT fatal: unordered polling is worse than
 * ordered, and far better than no polling at all.
 */
async function orderByLastRun(db, mailboxes, folder) {
  const lastRun = new Map()
  const ids = mailboxes.map(m => m.id)
  try {
    // Chunked so neither the 1,000-row cap nor the URL length can truncate the
    // answer silently. A partial ordering is not an error, but it IS the
    // starvation this function exists to prevent, so it must not happen by
    // accident at some row count nobody chose.
    for (let i = 0; i < ids.length; i += MAILBOX_PAGE_SIZE) {
      const { data, error } = await db
        .from('email_mailbox_ingress')
        .select('mailbox_id, last_run_at')
        .in('mailbox_id', ids.slice(i, i + MAILBOX_PAGE_SIZE))
        .eq('folder', folder)
        .order('mailbox_id', { ascending: true })
      if (error) {
        logWarn('imap-poll', 'could not order mailboxes by last run — polling unordered', { err: error })
        return mailboxes
      }
      for (const row of data || []) {
        const t = row?.last_run_at ? Date.parse(row.last_run_at) : NaN
        if (Number.isFinite(t)) lastRun.set(row.mailbox_id, t)
      }
    }
  } catch (err) {
    logWarn('imap-poll', 'ordering mailboxes threw — polling unordered', { err })
    return mailboxes
  }

  // -Infinity for a mailbox with no cursor row or no recorded attempt: it has
  // never been polled, so it goes first.
  return [...mailboxes].sort((a, b) =>
    (lastRun.has(a.id) ? lastRun.get(a.id) : -Infinity) -
    (lastRun.has(b.id) ? lastRun.get(b.id) : -Infinity))
}
