// IMAP-CONN.3.1/3.2 — the IMAP transport for the mailbox connector.
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §3
//
// WHY THIS IS NOT src/lib/recon/imap-client.js
// That file is the receipt-hunt engine's IMAP client. It is LIVE, it serves a
// different feature, and it hardcodes Gmail: `imap.gmail.com:993` and
// `[Gmail]/All Mail`. Both of those are wrong here and one of them is
// dangerous:
//   • host/port/TLS are per-mailbox here. This is a SaaS capability — any
//     operator connects any IMAP account — so provider config lives in
//     email_mailbox_credentials, not in a constant (§2.1).
//   • the folder is INBOX, deliberately (§3.4). `[Gmail]/All Mail` contains
//     SENT mail, so once Phase 7 sends replies over SMTP — which Gmail files
//     to Sent, and therefore to All Mail — every reply we sent would be
//     re-ingested as if a member had written it. INBOX closes that loop
//     structurally, before loadOwnAddresses() has to.
// Coupling the ticketing inbox to that file would put the receipt hunt at risk
// for no gain. Two files, one dependency, zero shared state.
//
// THE READ-ONLY POSTURE IS AN INVARIANT, NOT A DEFAULT (§3.4)
// A connected mailbox is a mailbox a HUMAN still opens — head office reads
// hatchstreet@un1t.com in Gmail, a coach might answer from a phone. We never
// write a flag, never mark anything \Seen, never move or delete anything. The
// customer's mailbox stays visually untouched and the CRM's own unread model
// stays the single source of truth. Every mailboxOpen() in this file passes
// `{ readOnly: true }`, and the test suite asserts it on every path, because
// "someone will add a second open() later and forget" is exactly how a
// read-only guarantee dies.
//
// AND LOGOUT ALWAYS RUNS. An abandoned IMAP connection holds a server-side
// session; Gmail caps simultaneous IMAP connections per account, and a poller
// that leaks one per tick locks the operator out of their own mailbox within
// the hour. `finally`, unconditionally, swallowing its own error — a failed
// logout must never mask the real error from `fn`.

import { ImapFlow } from 'imapflow'

/**
 * Timeouts, tightened well below imapflow's defaults (90s connect / 16s
 * greeting / 5min socket).
 *
 * This runs inside a Vercel function on a five-minute cron that has to get
 * round every connected mailbox in one invocation. A dead host must cost
 * seconds, not a
 * minute and a half, because §5.3 is explicit that one customer's broken
 * mailbox must never delay another's — and the cheapest way to honour that is
 * to make failure fast rather than to build a scheduler around it.
 */
const CONNECTION_TIMEOUT_MS = 20_000
const GREETING_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 60_000

/**
 * The headers fetched explicitly alongside the envelope.
 *
 * 🔴 imapflow's ENVELOPE carries `messageId` and `inReplyTo` but NOT
 * `References` — the IMAP ENVELOPE structure (RFC 3501 §7.4.2) simply has no
 * field for it. References is the header that carries the WHOLE ancestry of a
 * thread, and extractCandidateMessageIds() (src/lib/email-inbox.js) walks it
 * newest→oldest to find one of our sends. Without it, a reply three messages
 * deep into a chain — where the mail client has rewritten In-Reply-To to point
 * at the member's own last message rather than at ours — threads onto nothing
 * and opens a duplicate ticket. So the headers are fetched by name.
 *
 * Message-ID and In-Reply-To are fetched too even though the envelope has
 * them: the raw header is the ground truth, and having all three arrive by the
 * same route means the mapper has one code path rather than three.
 */
const THREADING_HEADERS = ['message-id', 'in-reply-to', 'references']

/** Messages per poll tick when the caller does not say. */
const DEFAULT_FETCH_CAP = 50

/** Longest error string we hand back — it lands in a `last_error` text column. */
const MAX_ERROR_CHARS = 500

/**
 * Build the ImapFlow options for a credential set.
 *
 * `auth` is passed through VERBATIM from auth-strategy.js — either
 * `{ user, pass }` or `{ user, accessToken }`. imapflow accepts both shapes on
 * the same option, which is the whole point of the OAuth seam (§2.1): when
 * OAuth eventually ships, nothing in this file changes.
 */
function clientOptions({ host, port, secure, auth }) {
  return {
    host,
    port: port ?? 993,
    // Explicit `!== false` rather than `?? true`: an operator toggling TLS off
    // for a legacy host must actually get STARTTLS negotiation, not a silent
    // upgrade back to implicit TLS on a port that does not speak it.
    secure: secure !== false,
    auth,
    // Never log. imapflow's default logger prints command traffic, and the
    // LOGIN command carries the customer's mailbox password (§6).
    logger: false,
    // We are a cron poller, not an IDLE client (§7 — "IMAP IDLE" is on the
    // explicit not-building list). Auto-IDLE would keep the socket in a
    // command state we then have to break out of on every fetch, for a push
    // channel a serverless function cannot hold open anyway.
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  }
}

/**
 * An error message safe to store and to show an operator.
 *
 * Two jobs. (1) REDACT: the secret must never reach `last_error`, which is
 * read back by a settings route and rendered in the UI. imapflow does not echo
 * credentials in its errors today, but "today" is not a guarantee worth a
 * customer's mailbox password appearing in a screenshot. (2) CAP: an IMAP
 * server can answer with a multi-kilobyte BAD response, and an unbounded
 * string rides along on every read of the connection card forever.
 */
function safeError(err, auth) {
  const raw = String(err?.responseText || err?.message || err || 'unknown error')
  let out = raw
  for (const secret of [auth?.pass, auth?.accessToken]) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out.slice(0, MAX_ERROR_CHARS)
}

/**
 * Connect, open one folder READ-ONLY, run `fn`, and always log out.
 *
 * @param {{host: string, port?: number, secure?: boolean, auth: object}} config
 *   host/port/TLS from email_mailbox_credentials; `auth` straight from
 *   resolveAuth() — `{ user, pass }` or `{ user, accessToken }`.
 * @param {string} folderPath  'INBOX' today; Phase 8 passes the provider's
 *   Sent folder (email_mailbox_credentials.sent_folder) through the same door.
 * @param {(client: import('imapflow').ImapFlow, mailbox: object) => Promise<any>} fn
 *   `mailbox` is the MailboxObject mailboxOpen() returns — it carries
 *   `uidValidity` and `uidNext`, which the poller needs for cursor discipline
 *   (§3.3 re-anchor) and cold-start anchoring (§3.5). Handing it to `fn` is
 *   what stops Phase 5 having to issue a second STATUS round trip for values
 *   the SELECT response already gave us.
 * @param {{createClient?: Function}} [deps]  test seam ONLY — lets the unit
 *   tests drive a fake client instead of the network. Production callers pass
 *   nothing. It is a separate trailing argument rather than a property on
 *   `config` so that the config object stays exactly the credential row shape
 *   the routes and the poller build.
 * @returns whatever `fn` returns.
 * @throws whatever connect/open/`fn` throws — withMailbox does NOT swallow.
 *   The poller's per-mailbox try/catch is the right place to decide, and it
 *   needs the real error to tell an auth failure from a transport failure
 *   (§9.3: a revoked password is an operator action, not an outage).
 */
export async function withMailbox({ host, port, secure, auth }, folderPath, fn, deps = {}) {
  const createClient = deps.createClient || ((opts) => new ImapFlow(opts))
  const client = createClient(clientOptions({ host, port, secure, auth }))
  await client.connect()
  try {
    // 🔴 readOnly: true. Not negotiable, not configurable, not overridable
    // from the caller — see the header comment. imapflow's own default is
    // false, so omitting the option would silently issue SELECT instead of
    // EXAMINE and Gmail would start marking the operator's mail as read.
    const mailbox = await client.mailboxOpen(folderPath, { readOnly: true })
    return await fn(client, mailbox)
  } finally {
    // Swallowed deliberately: a logout that fails after a successful poll must
    // not turn a good tick into a failed one, and a logout that fails after
    // `fn` threw must not replace the diagnosis with "connection closed".
    await client.logout().catch(() => {})
  }
}

/**
 * Live connect + folder-open check for the operator-facing connect screen
 * (Phase 6.1 verifies BEFORE persisting, mirroring verifyMailboxLogin in the
 * recon add-inbox route).
 *
 * NEVER THROWS. It returns a verdict envelope because the thing on the other
 * end of it is a person typing a password into a form: "Invalid credentials
 * (Failure)" is an answer they can act on, and a 500 is not. This is the same
 * fail-safe shape as tenant-email.js and auth-strategy.js.
 *
 * @param {{host: string, port?: number, secure?: boolean, auth: object}} config
 * @param {string} [folderPath='INBOX']
 * @param {{createClient?: Function}} [deps]  test seam; see withMailbox.
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function verifyConnection({ host, port, secure, auth }, folderPath = 'INBOX', deps = {}) {
  try {
    await withMailbox({ host, port, secure, auth }, folderPath, async () => true, deps)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: safeError(err, auth) }
  }
}

/**
 * Messages with a UID strictly greater than `sinceUid`, oldest first.
 *
 * @param {import('imapflow').ImapFlow} client  a client with a folder already
 *   open — i.e. one inside a withMailbox() callback.
 * @param {{sinceUid: number, cap?: number}} options
 * @returns {Promise<object[]>} raw imapflow message objects, ascending by uid:
 *   `{ uid, envelope, bodyStructure, internalDate, size, headers }`. Bodies
 *   and attachments are NOT downloaded here — the caller walks bodyStructure
 *   and fetches only the parts it wants, which is the MAX_PART_BYTES pattern
 *   the risk table calls for (a 40MB message must not exhaust the function).
 *
 * THREE THINGS IN HERE ARE LOAD-BEARING.
 *
 * 1. `N:*` ALWAYS RETURNS AT LEAST ONE MESSAGE. This is the classic IMAP trap
 *    (RFC 3501 §6.4.8): if no message has a UID >= N, the server answers with
 *    the HIGHEST existing UID anyway rather than an empty set. A poller that
 *    trusted the range would re-ingest its newest message on every single
 *    tick, forever — deduped downstream, yes, but every tick would do a
 *    pointless round trip and (worse) a cursor bug would look like a working
 *    system. The `> sinceUid` filter below is what makes the range mean what
 *    it reads like.
 *
 * 2. THE CAP TAKES THE OLDEST, NEVER THE NEWEST. On a backlog of 500 with a
 *    cap of 50 we take UIDs 1..50 and let the next tick take 51..100. Taking
 *    the newest 50 instead would advance the watermark past 450 messages that
 *    were never filed — silent, permanent mail loss, and invisible because the
 *    inbox would look busy. Server FETCH responses arrive in ascending
 *    sequence order and IMAP assigns UIDs "in a strictly ascending fashion"
 *    (RFC 3501 §2.3.1.1), so sequence order IS uid order and breaking out of
 *    the iterator at `cap` yields a contiguous oldest-first prefix. The
 *    defensive sort makes that guarantee explicit rather than assumed.
 *
 * 3. AN UNREADABLE CURSOR FAILS CLOSED, LOUDLY. A missing/NaN `sinceUid`
 *    coerced to 0 would fetch `1:*` — the entire mailbox — and file years of
 *    correspondence as fresh tickets, with push notifications, on a mailbox
 *    someone just connected. That is the one shape of failure the design
 *    forbids outright ("no backfill, ever", §3.5). This is the narrow case the
 *    CLAUDE.md invariant allows failing closed for: proceeding is actively
 *    harmful and irreversible, and the caller's per-mailbox catch turns the
 *    throw into a recorded `last_error` rather than a lost message.
 *    `sinceUid: 0` is still perfectly legal — that is a mailbox anchored while
 *    empty — so this rejects only values that are not a whole number >= 0.
 */
export async function fetchSince(client, { sinceUid, cap } = {}) {
  if (!Number.isInteger(sinceUid) || sinceUid < 0) {
    throw new Error(
      `fetchSince: refusing to fetch with an unusable cursor (sinceUid=${String(sinceUid)}). ` +
      'A missing cursor would fetch the whole mailbox and backfill it as tickets.'
    )
  }
  // A bad cap only costs a smaller/larger batch, so it defaults quietly —
  // opposite of the cursor, where the wrong value is catastrophic.
  const limit = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_FETCH_CAP

  const out = []
  for await (const msg of client.fetch(
    `${sinceUid + 1}:*`,
    {
      uid: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
      // See THREADING_HEADERS — this is the References fetch, and it is the
      // reason threading works at all.
      headers: THREADING_HEADERS,
    },
    { uid: true }
  )) {
    // Trap 1: drop the "highest UID" the server volunteers when the range
    // matched nothing.
    if (!Number.isFinite(msg?.uid) || msg.uid <= sinceUid) continue
    out.push(msg)
    if (out.length >= limit) break
  }

  return out.sort((a, b) => a.uid - b.uid)
}
