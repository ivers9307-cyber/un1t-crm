// INBOX-SURFACE.A — the ONLY place this codebase writes to a customer's IMAP
// mailbox. Two operations, one surface, no delete.
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §3.4
//
// ══ 🔴 READ imap-connection.js's HEADER BEFORE THIS ONE ═════════════
// That file states the connector's read-only posture as an INVARIANT: every
// mailboxOpen() it issues passes `{ readOnly: true }`, it never sets a flag,
// never moves anything, never deletes anything, and its own test suite asserts
// that on every path. That is a real safety property — a connected mailbox is
// a mailbox a HUMAN still opens, and a customer's Gmail staying visually
// untouched is a promise worth keeping.
//
// THIS FILE NARROWS THAT PROMISE. IT DOES NOT REMOVE IT.
//
// The inbox surface needs two writes or it is a mirror with an Archive button
// that lies: Richard clicks Archive here, the message stays bold in Gmail, and
// he triages it a second time — which is the exact cost the surface exists to
// remove. So:
//
//   1. mark \Seen        (messageFlagsAdd)
//   2. move to Archive   (messageMove)
//
// and NOTHING ELSE, EVER, on mailboxes whose `surface` is 'inbox' and nothing
// else. In particular:
//
// 🔴 DELETING IS NOT IN SCOPE AND MUST NEVER BE ADDED. Archive is recoverable
// — Gmail keeps the message in All Mail, Outlook keeps it in Archive — and
// delete is not. There is no version of this trial that justifies giving a CRM
// the ability to destroy a customer's correspondence. If a future requirement
// seems to need it, the answer is a folder move to somewhere else, not an
// expunge.
//
// 🔴 AND "THERE IS NO EXPUNGE IN THIS FILE" IS NOT ENOUGH — IT WAS ONCE WRITTEN
// HERE AND IT WAS NOT TRUE. `client.messageMove()` silently EMULATES a move on
// any server that does not advertise RFC 6851 MOVE, as COPY + \Deleted +
// EXPUNGE, with the delete unconditional even when the copy failed — i.e. the
// precise sequence this comment forbade, one call inside a dependency. The
// property is only real because archiveMessage now REFUSES when the server does
// not advertise MOVE. Read that guard before touching the archive path, and
// treat "our source contains no delete" as an unproven claim about the wire
// whenever a library is between the two.
//
// ══ THE GUARD IS AT THE SOURCE, AND IT RE-READS THE DATABASE ════════
// Every entry point starts by loading the mailbox row BY ID and refusing
// unless `surface = 'inbox'`. It does NOT trust a `surface` field on whatever
// object the caller passed, because the whole point of a source-side guard is
// that a future caller — a bulk action, a cron, a script, an agent tool —
// cannot mutate a ticketing mailbox by constructing `{ surface: 'inbox' }` or
// by handing over a row it read five minutes ago. One extra SELECT per write
// is the correct price for "this cannot be got wrong from outside".
//
// The same read also refuses a mailbox that is not `ingress = 'imap'` (there
// is no account to write to) and one that is deactivated (an operator has
// already said stop touching this).
//
// ══ WHY THE WRITABLE OPEN LIVES HERE AND NOT IN imap-connection.js ══
// withMailbox() forces `readOnly: true` and is asserted to on every path by a
// test suite this phase does not own. Adding a write door to that module would
// mean the file whose header promises "we never write" contains the write, and
// would weaken an invariant whose enforcement lives in a test file this phase
// cannot update in step.
//
// So the writable open is HERE, where the reader already knows they are in the
// file that writes. Everything else about the connection is a deliberate,
// line-for-line copy of imap-connection.js's discipline, because every line of
// it is a lesson:
//
//   • connect() is INSIDE the try. imapflow does NOT close the socket when
//     LOGIN fails — startSession() rejects with the TCP connection still up —
//     so a connect in front of the try leaks a live session on exactly the
//     failure that repeats. Gmail caps simultaneous IMAP connections per
//     account, and leaking them locks the operator out of their own mailbox.
//   • the release is LOGOUT first, then close() unconditionally behind it,
//     both swallowed. A failed release must never mask the real error.
//   • `logger: false`. imapflow's default logger prints command traffic, and
//     the LOGIN command carries the customer's mailbox password.
//
// 🔴 IF THIS EVER MOVES INTO imap-connection.js, it must go in as a SECOND
// exported door (withWritableMailbox) sharing one private opener with
// withMailbox — never as an option on withMailbox with a default, because a
// default is what a caller forgets.
//
// ══ NEVER THROWS ════════════════════════════════════════════════════
// Every export returns a verdict envelope, the same fail-safe shape as
// verifyConnection() and auth-strategy.js. The thing on the other end of these
// calls is a person clicking Archive in a list: "That account's login was
// refused" is something they can act on and a 500 is not. And per the callers'
// own contract, a write-back failure must never cost the message or stall the
// lane — a verdict is what makes "log it and carry on" the easy thing to do.

import { ImapFlow } from 'imapflow'
import { logError, logWarn } from '../log'
import { resolveFreshAuth } from './oauth-tokens'

/* ────────────────────────────── constants ─────────────────────────────── */

/**
 * 🔴 The only value of email_mailboxes.surface this module will write for.
 *
 * Exported so a caller can say what it is checking for without spelling the
 * literal, and so a test can assert the refusal against the same constant the
 * guard uses rather than against a copy of the string.
 */
export const INBOX_SURFACE = 'inbox'

/** The folder the inbox surface reads and writes. See imap-connection.js §3.4. */
const INBOX_PATH = 'INBOX'

/**
 * Timeouts, matching imap-connection.js rather than imapflow's defaults
 * (90s connect / 16s greeting / 5min socket).
 *
 * These run on a REQUEST thread, not the cron: an operator clicked Archive and
 * is watching a spinner. A dead mail host must cost seconds and hand back a
 * verdict, not hold a Vercel function open for ninety.
 */
const CONNECTION_TIMEOUT_MS = 20_000
const GREETING_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 60_000

/** Longest error string we hand back — it may be rendered to an operator. */
const MAX_ERROR_CHARS = 500

/**
 * The mailbox columns the guard needs, named rather than `select('*')`.
 *
 * `surface` is the gate. `ingress` and `active` are the other two ways a write
 * can be wrong for a mailbox that happens to be on the right surface.
 */
const WRITEBACK_MAILBOX_COLUMNS = 'id, location_id, address, active, ingress, surface'

/**
 * The credential columns. Same list as the poller's, minus the two it needs
 * for lanes we do not touch, plus `archive_folder` (mig 575).
 *
 * 🔴 oauth_refresh_token_ciphertext is load-bearing and its absence is SILENT:
 * resolveFreshAuth needs it to renew a spent access token, and omitting it
 * makes every OAuth mailbox work for one token lifetime and then report an
 * expired sign-in forever — with every log line saying the call ran correctly,
 * because it did. Named for the same reason the poller names it.
 */
const CREDENTIAL_COLUMNS = [
  'mailbox_id', 'provider', 'auth_type', 'username',
  'secret_ciphertext',
  'oauth_access_token_ciphertext', 'oauth_refresh_token_ciphertext', 'oauth_expires_at',
  'imap_host', 'imap_port', 'imap_secure', 'archive_folder',
].join(', ')

/**
 * SPECIAL-USE flags (RFC 6154) that name a place a message can be archived TO,
 * in preference order.
 *
 * `\Archive` is the standard answer and is what Outlook and most IMAP servers
 * advertise. `\All` is the fallback that exists for Gmail, which has no
 * \Archive at all: its "archive" is the removal of the INBOX label, and the
 * folder that always holds the message afterwards is `[Gmail]/All Mail`,
 * advertised as \All.
 *
 * 🔴 \Trash AND \Junk ARE DELIBERATELY ABSENT AND MUST STAY ABSENT. Moving a
 * member's email to Trash is a delete with extra steps — it is reaped on the
 * provider's own schedule with nothing here to stop it — and Junk additionally
 * teaches the provider's spam classifier that the studio's own correspondence
 * is spam. A server that advertises neither \Archive nor \All gets a refusal
 * and an operator-readable sentence, not a guess.
 */
const ARCHIVE_SPECIAL_USE = ['\\Archive', '\\All']

/**
 * Folder paths tried by NAME when the server advertises no usable SPECIAL-USE.
 *
 * Last resort, and deliberately short: a name match is a guess, and the guess
 * that matters is the one an operator can override
 * (email_mailbox_credentials.archive_folder). Compared case-insensitively
 * against the server's own list, so a folder is only ever used if the server
 * says it exists — this never MOVEs into a path it has not seen listed, which
 * is what stops a server that auto-creates on COPY from growing a stray folder.
 */
const ARCHIVE_NAME_FALLBACKS = ['Archive', 'Archives', 'INBOX.Archive', '[Gmail]/All Mail']

/**
 * 🔴 FOLDERS THE ARCHIVE ACTION MUST NEVER MOVE MAIL INTO, whatever anyone
 * configured.
 *
 * The auto-discovery above is safe by construction — it only ever SELECTS
 * \Archive/\All or a name off the list — so it can never answer Trash. The
 * operator-configured override was not: it accepted any path that existed on
 * the server, so setting the archive folder to "Deleted Items" turned this
 * module's primary verb into a delete with extra steps, reaped on the
 * provider's own schedule with nothing here to stop it. The guarantee has to
 * hold on BOTH paths or it is not a guarantee, and the one a human types is
 * the likelier of the two to get it wrong.
 *
 * Matched on the server's own SPECIAL-USE flag first (authoritative) and on
 * conventional names second, since plenty of servers advertise nothing.
 */
const FORBIDDEN_SPECIAL_USE = ['\\Trash', '\\Junk']
const FORBIDDEN_NAMES = [
  'trash', 'deleted', 'deleted items', 'deleted messages', 'bin',
  'junk', 'junk email', 'spam', 'bulk mail',
  'inbox.trash', 'inbox.junk', 'inbox.spam',
  '[gmail]/trash', '[gmail]/bin', '[gmail]/spam',
]

/** Is this folder one the archive action must refuse outright? */
function isForbiddenArchiveFolder(box) {
  const flag = String(box?.specialUse || '').toLowerCase()
  if (FORBIDDEN_SPECIAL_USE.some(f => f.toLowerCase() === flag)) return true
  const path = String(box?.path || '').toLowerCase()
  return FORBIDDEN_NAMES.includes(path)
}

/* ─────────────────────── failure classification ──────────────────────── */
//
// 🔴 A DELIBERATE, PINNED COPY of classifyImapFailure() and
// operatorFacingDialError() from imap-poll.js — the same kind of deliberate
// duplication imap-poll.js itself makes of imap-connection.js's safeError(),
// and for a sharper reason.
//
// Importing them would drag imap-poll.js's whole module graph — the sent-lane
// writer, the attachment server, the inbound mapper — into every API route
// that wants to mark one message read. This module is REQUEST-SCOPED; the
// poller is a cron. They should not share a bundle.
//
// The drift risk that duplication normally carries is answered by a test
// rather than by a comment: imap-writeback.test.js imports BOTH copies and
// asserts they agree over a table of inputs, so a change to one that is not
// made to the other fails the suite.

/**
 * Is this failure the operator's to fix, or an outage?
 *
 * It picks the sentence the operator is shown, and the two need different
 * actions: a revoked app password is something they regenerate, an unreachable
 * host is a typo or a provider outage. imapflow marks every LOGIN/AUTHENTICATE
 * rejection with `authenticationFailed`, so the flag is the primary signal and
 * the text match is only a backstop for a server that answers in prose.
 */
export function classifyWritebackFailure(err) {
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
 * What the OPERATOR is told, by category. Fixed strings.
 *
 * 🔴 NOTHING HERE VARIES WITH WHAT THE REMOTE SERVER SAID (MAILBOX-CONNECT.8).
 * These sentences can reach a customer-tier owner, and echoing `responseText`
 * would turn an Archive button into a probe: a mailbox pointed at an internal
 * host must report exactly what an unreachable public one reports. The detail
 * an engineer needs goes to the log, which is not a screen.
 */
export function operatorFacingWriteError(kind) {
  return kind === 'auth'
    ? 'The mail server refused this login. If the account uses two-step verification the password here must be an app password, and a revoked one fails exactly like this — generate a new one and save it again.'
    : 'Could not reach the mail server, so the change was not made in the mailbox. Try again; if it keeps failing, the provider may be having an outage.'
}

/** An error string safe to log. Redacts our own secrets, caps the length. */
function safeErrorText(err, auth) {
  let out = String(err?.responseText || err?.message || err || 'unknown error')
  for (const secret of [auth?.pass, auth?.accessToken]) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out.slice(0, MAX_ERROR_CHARS)
}

/* ────────────────────── the writable connection ──────────────────────── */

/**
 * Connect, open ONE folder READ-WRITE, run `fn`, and always release.
 *
 * The twin of withMailbox() in imap-connection.js, and the ONLY difference is
 * `readOnly: false`. Read that file's header for why every other line is the
 * way it is; the summary is in this file's header.
 *
 * `readOnly: false` is stated explicitly rather than omitted even though it is
 * imapflow's own default, because an omitted option here reads as an oversight
 * and this is the one place in the codebase where issuing SELECT rather than
 * EXAMINE is the intent.
 *
 * @param {{host: string, port?: number, secure?: boolean, auth: object}} config
 * @param {string} folderPath
 * @param {(client: import('imapflow').ImapFlow, mailbox: object) => Promise<any>} fn
 * @param {{createClient?: Function}} [deps]  test seam ONLY — production
 *   callers pass nothing. Same shape as imap-connection.js's, so a fake IMAP
 *   written for the poller's tests drives this too.
 * @returns whatever `fn` returns.
 * @throws whatever connect/open/`fn` throws — this does NOT swallow. The
 *   caller's classify-and-verdict step needs the real error to tell a revoked
 *   password from an unreachable host.
 */
export async function withWritableMailbox({ host, port, secure, auth }, folderPath, fn, deps = {}) {
  const createClient = deps.createClient || ((opts) => new ImapFlow(opts))
  const client = createClient({
    host,
    port: port ?? 993,
    // Explicit `!== false`, matching imap-connection.js: an operator who
    // turned TLS off for a legacy host must get STARTTLS negotiation, not a
    // silent upgrade back to implicit TLS on a port that does not speak it.
    secure: secure !== false,
    auth,
    // 🔴 NEVER LOG. imapflow's default logger prints command traffic and the
    // LOGIN command carries the customer's mailbox password.
    logger: false,
    // A request-scoped write is not an IDLE client any more than the poller is.
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  })
  try {
    // 🔴 INSIDE the try — see the header. A LOGIN failure leaves the socket up,
    // and outside the try the `finally` below would never run for it.
    await client.connect()
    const mailbox = await client.mailboxOpen(folderPath, { readOnly: false })
    return await fn(client, mailbox)
  } finally {
    await releaseConnection(client)
  }
}

/** End the session, whatever state it is in. NEVER THROWS. */
async function releaseConnection(client) {
  try {
    await client.logout()
  } catch {
    // Deliberate: a logout is a no-op on a socket that never came up and can
    // fail on one that did. What must be true either way is that no socket is
    // left holding one of the provider's per-account connection slots.
  }
  try {
    client.close?.()
  } catch {
    // Deliberate — see above. A failed release must never mask the real error.
  }
}

/* ─────────────────────────── the source guard ─────────────────────────── */

/**
 * 🔴 THE GUARD. Load the mailbox BY ID and refuse unless it is an inbox-surface
 * IMAP mailbox that is still active.
 *
 * Re-read from the database on purpose — see the header. A caller cannot talk
 * its way past this with a hand-built object or a stale row.
 *
 * @returns {Promise<{ok: true, mailbox: object} | {ok: false, reason: string, error: string}>}
 */
async function loadWritableMailbox(db, mailboxId) {
  let row
  try {
    // `.eq('id', …)` pins the primary key, so `.maybeSingle()` can only ever
    // answer one row or none, and "none" is a legitimate answer (a mailbox
    // deleted between the caller reading it and calling us). The error is
    // destructured and judged rather than discarded — a read we could not do
    // is NOT the same as a mailbox that is not on the inbox surface, and
    // collapsing the two would make an outage look like a policy refusal.
    const { data, error } = await db
      .from('email_mailboxes')
      .select(WRITEBACK_MAILBOX_COLUMNS)
      .eq('id', mailboxId)
      .maybeSingle()
    if (error) {
      logError('imap-writeback', 'could not read the mailbox — refusing the write', { mailboxId, err: error })
      return {
        ok: false,
        reason: 'mailbox_unreadable',
        error: 'Could not check which surface this account belongs to, so nothing was changed in the mailbox.',
      }
    }
    row = data
  } catch (err) {
    logError('imap-writeback', 'reading the mailbox threw — refusing the write', { mailboxId, err })
    return {
      ok: false,
      reason: 'mailbox_unreadable',
      error: 'Could not check which surface this account belongs to, so nothing was changed in the mailbox.',
    }
  }

  if (!row) {
    return { ok: false, reason: 'mailbox_not_found', error: 'That email account no longer exists.' }
  }

  // 🔴 THE REFUSAL THIS MODULE EXISTS FOR. A ticketing-surface mailbox has
  // never had an IMAP flag written to it and must not start now because some
  // future caller reached for the nearest helper. Logged at WARN rather than
  // silently returned: a call that gets here is a bug in the caller, and a
  // refusal nobody can see is how the bug survives.
  if (row.surface !== INBOX_SURFACE) {
    logWarn('imap-writeback', 'refused an IMAP write on a mailbox that is not on the inbox surface', {
      mailboxId, surface: row.surface ?? null,
    })
    return {
      ok: false,
      reason: 'not_inbox_surface',
      error: 'This account is on the ticketing surface, which never changes anything in the mailbox itself.',
    }
  }

  if (row.ingress !== 'imap') {
    return {
      ok: false,
      reason: 'not_imap',
      error: 'This account receives mail through Postmark rather than a connected login, so there is no mailbox to change.',
    }
  }

  if (row.active === false) {
    return {
      ok: false,
      reason: 'mailbox_inactive',
      error: 'This account is deactivated, so nothing is changed in the mailbox.',
    }
  }

  return { ok: true, mailbox: row }
}

/**
 * The credential row plus a live auth object, or a verdict saying why not.
 *
 * resolveFreshAuth rather than resolveAuth, for the reason the poller states:
 * for a password row it IS resolveAuth, and for an OAuth row it renews a spent
 * access token first. Without it an OAuth mailbox works for one token lifetime
 * and then refuses forever.
 */
async function resolveMailboxAuth(db, mailboxId, now) {
  let credential
  try {
    const { data, error } = await db
      .from('email_mailbox_credentials')
      .select(CREDENTIAL_COLUMNS)
      .eq('mailbox_id', mailboxId)
      .maybeSingle()
    if (error) {
      logError('imap-writeback', 'credential lookup failed', { mailboxId, err: error })
      return { ok: false, reason: 'credential_lookup_failed', error: operatorFacingWriteError('transport') }
    }
    credential = data
  } catch (err) {
    logError('imap-writeback', 'credential lookup threw', { mailboxId, err })
    return { ok: false, reason: 'credential_lookup_failed', error: operatorFacingWriteError('transport') }
  }

  if (!credential) {
    return {
      ok: false,
      reason: 'no_credential',
      error: 'No login is stored for this account, so nothing can be changed in the mailbox.',
    }
  }

  const verdict = await resolveFreshAuth(db, credential, { now: () => now })
  if (!verdict.ok) {
    // resolveFreshAuth's `error` is a constant sentence written for a person —
    // no remote server's words in it — so it is passed through verbatim, which
    // is what the poller does with the same values.
    return { ok: false, reason: verdict.reason, error: verdict.error }
  }
  return { ok: true, credential, auth: verdict.auth }
}

/* ──────────────────────── the archive destination ─────────────────────── */

/**
 * Which folder Archive moves a message TO. PURE — the caller does the LIST.
 *
 * Order, and each step is a different kind of answer:
 *   1. the operator's own `archive_folder`, when the server confirms a folder
 *      by that path exists. Configuration beats discovery, because a server
 *      can advertise a folder the studio does not actually use.
 *   2. SPECIAL-USE (RFC 6154): \Archive, then \All for Gmail. This is the
 *      server telling us in its own words where archived mail goes.
 *   3. a short list of conventional NAMES, matched case-insensitively against
 *      the folders the server listed.
 *
 * 🔴 EVERY STEP REQUIRES THE FOLDER TO BE IN THE SERVER'S OWN LIST, including
 * the configured one. Never MOVE into a path the server has not said exists:
 * some servers auto-create on COPY/MOVE, so a typo in the settings field would
 * silently grow a stray folder and quietly file a studio's mail into it. A
 * configured path the server does not list is an operator mistake worth a
 * refusal they can read.
 *
 * @param {Array<{path?: string, specialUse?: string}>} boxes  client.list()
 * @param {string|null} [configured]  email_mailbox_credentials.archive_folder
 * @returns {{ok: true, path: string, via: 'configured'|'special-use'|'name'}
 *          |{ok: false, reason: string, error: string}}
 */
export function pickArchiveFolder(boxes, configured = null) {
  const list = Array.isArray(boxes) ? boxes.filter(b => typeof b?.path === 'string' && b.path) : []

  const wanted = typeof configured === 'string' ? configured.trim() : ''
  if (wanted) {
    const exact = list.find(b => b.path === wanted)
    if (exact && isForbiddenArchiveFolder(exact)) {
      return {
        ok: false,
        reason: 'archive_folder_forbidden',
        error: `“${wanted}” is a trash or junk folder, so nothing was moved there. Archiving must keep the message recoverable — pick a real archive folder on this account's connection settings.`,
      }
    }
    if (exact) return { ok: true, path: exact.path, via: 'configured' }
    return {
      ok: false,
      reason: 'archive_folder_missing',
      // Names the configured value back, which is the studio's OWN setting and
      // not the remote server's words — safe to render, and the only way the
      // operator can tell a typo from a renamed folder.
      error: `The mail server has no folder called “${wanted}”. Check the archive folder on this account's connection settings.`,
    }
  }

  for (const flag of ARCHIVE_SPECIAL_USE) {
    const match = list.find(b => String(b.specialUse || '').toLowerCase() === flag.toLowerCase())
    if (match) return { ok: true, path: match.path, via: 'special-use' }
  }

  for (const name of ARCHIVE_NAME_FALLBACKS) {
    const match = list.find(b => b.path.toLowerCase() === name.toLowerCase())
    if (match) return { ok: true, path: match.path, via: 'name' }
  }

  return {
    ok: false,
    reason: 'no_archive_folder',
    error: 'This mail server does not say where archived mail goes. Set the archive folder on this account’s connection settings and try again.',
  }
}

/* ──────────────────────────── which message ───────────────────────────── */

/**
 * The UID to act on, resolved from whatever the caller could supply.
 *
 * A caller holding an `email_inbox_messages` row does NOT have a UID — nothing
 * writes one onto that row, because the row is written by the inbound webhook
 * route, which has never heard of IMAP. What it does have is
 * `rfc_message_id`, stored BARE (brackets stripped), so that is the second
 * door: a UID SEARCH on the Message-ID header.
 *
 * `HEADER MESSAGE-ID` is a substring match in IMAP, so a bare id matches the
 * bracketed header value — which is why the caller does not have to know which
 * form the mailbox stores.
 *
 * 🔴 MORE THAN ONE HIT IS A REFUSAL, NOT A PICK. Two messages in one INBOX
 * carrying the same Message-ID means either a duplicate delivery or a header
 * collision, and archiving "the first one" would move a message the operator
 * did not choose, out of a folder they can no longer see it in. Refusing costs
 * a click; guessing costs a message somebody has to go and find.
 *
 * @returns {Promise<{ok: true, uid: number} | {ok: false, reason: string, error: string}>}
 */
async function resolveTargetUid(client, { uid, rfcMessageId }) {
  if (Number.isInteger(uid) && uid > 0) return { ok: true, uid }

  const id = typeof rfcMessageId === 'string' ? rfcMessageId.trim().replace(/^<|>$/g, '') : ''
  if (!id) {
    return {
      ok: false,
      reason: 'no_message_reference',
      error: 'That message cannot be matched back to the mailbox, so nothing was changed there.',
    }
  }

  const found = await client.search({ header: { 'message-id': id } }, { uid: true })

  // 🔴 IMAPFLOW REPORTS A FAILED COMMAND BY RETURNING `false`, NOT BY THROWING.
  // commands/search.js returns `false` for a NO/BAD, for a parse error, AND for
  // a session that is not in SELECTED state. An array — empty or not — is the
  // ONLY success. Coercing a non-array to `[]` read every one of those as "the
  // message is not in the mailbox", which applyWriteback deliberately counts as
  // SUCCESS: a transient Gmail `NO [LIMIT]` told the operator their mail had
  // been archived by a search that never ran. The two states must not collapse
  // — an empty array is an answer, `false` is the absence of one.
  if (!Array.isArray(found)) {
    return { ok: false, reason: 'search_failed', error: operatorFacingWriteError('transport') }
  }

  const uids = found
    .map(n => Number(n))
    .filter(n => Number.isInteger(n) && n > 0)

  if (uids.length === 0) {
    return {
      ok: false,
      reason: 'not_in_mailbox',
      error: 'That message is no longer in the mailbox — it may already have been moved or archived there.',
    }
  }
  if (uids.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_message',
      error: 'The mailbox holds more than one copy of that message, so it was left alone rather than changing the wrong one.',
    }
  }
  return { ok: true, uid: uids[0] }
}

/* ───────────────────────────── the two writes ─────────────────────────── */

/**
 * The shell every write shares: guard, credentials, connect read-WRITE,
 * resolve the UID, run `work`, and never throw.
 *
 * Factored so the two operations are each a handful of lines that say what
 * they do — and so the guard cannot be forgotten by whoever adds a third one.
 * (There is no third one. See the header.)
 *
 * @param {object} db  service-role Supabase client
 * @param {string|{id: string}} mailbox  a mailbox id, or any object carrying
 *   one. Everything ELSE about the mailbox is re-read from the database.
 * @param {object} options
 * @param {number} [options.uid]            the IMAP UID, when the caller has one
 * @param {string} [options.rfcMessageId]   email_inbox_messages.rfc_message_id
 * @param {number} [options.now=Date.now()] injectable clock, for tests
 * @param {{createClient?: Function}} [options.deps]  test seam
 * @param {string} op  the operation name, for logs
 * @param {(ctx: {client: object, uid: number, credential: object}) => Promise<object>} work
 */
async function runWriteback(db, mailbox, options, op, work) {
  const { uid, rfcMessageId, now = Date.now(), deps } = options || {}
  const mailboxId = typeof mailbox === 'string' ? mailbox.trim() : (mailbox?.id ?? '')

  if (!mailboxId || typeof mailboxId !== 'string') {
    logError('imap-writeback', 'refusing a write with no mailbox id', { op })
    return { ok: false, reason: 'invalid_mailbox', error: 'No email account was named, so nothing was changed.' }
  }

  const guard = await loadWritableMailbox(db, mailboxId)
  if (!guard.ok) return guard

  const authVerdict = await resolveMailboxAuth(db, mailboxId, now)
  if (!authVerdict.ok) return authVerdict
  const { credential, auth } = authVerdict

  try {
    return await withWritableMailbox(
      {
        host: credential.imap_host,
        port: credential.imap_port,
        secure: credential.imap_secure,
        auth,
      },
      INBOX_PATH,
      async (client) => {
        const target = await resolveTargetUid(client, { uid, rfcMessageId })
        if (!target.ok) return target
        return await work({ client, uid: target.uid, credential, mailboxId })
      },
      deps,
    )
  } catch (err) {
    // 🔴 TWO AUDIENCES, ONE OF WHICH GETS THE SERVER'S WORDS AND IT IS NOT THE
    // OPERATOR (MAILBOX-CONNECT.8). The log carries the detail an engineer
    // needs; the verdict carries a category the operator can act on.
    const kind = classifyWritebackFailure(err)
    logError('imap-writeback', 'an IMAP write failed', {
      mailboxId, op, kind, err: { message: safeErrorText(err, auth) },
    })
    return {
      ok: false,
      reason: kind === 'auth' ? 'auth_failed' : 'write_failed',
      error: operatorFacingWriteError(kind),
    }
  }
}

/**
 * Mark one message \Seen in the mailbox itself.
 *
 * The paired half of email_inbox_messages.seen_at: the CRM's own column is a
 * MIRROR of this flag, converged by syncSeenFlags() in imap-poll.js, so a
 * surface that writes the column without calling this will simply be converged
 * back to the mailbox's answer at the next sync. Write both, or write neither.
 *
 * 🔴 There is no markUnseen(), on purpose. Clearing \Seen is the one direction
 * where a mistaken write costs the operator something real — a message they
 * had dealt with reappearing as new, in Gmail, on their phone — and no part of
 * the inbox surface needs it. The mirror already carries "marked unread in
 * Gmail" INTO the CRM, which is the direction that matters.
 *
 * @returns {Promise<{ok: true, applied: boolean, uid: number}
 *                  |{ok: false, reason: string, error: string}>}
 *   `applied: false` means the server accepted the command but reported that it
 *   matched nothing — the message left the folder between the search and the
 *   store. Not an error: the intent (this is not unread any more) is satisfied.
 */
export async function markSeen(db, mailbox, options = {}) {
  return runWriteback(db, mailbox, options, 'mark_seen', async ({ client, uid, mailboxId }) => {
    // String range + `{ uid: true }`: imapflow resolves a UID range rather than
    // a sequence number, and sequence numbers shift under any concurrent
    // expunge — which is exactly what a human working the same mailbox in
    // Gmail produces.
    const applied = await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
    // See resolveTargetUid: `false` is a FAILED STORE (commands/store.js returns
    // `true` on success and `false` only in its catch). A UID range that matches
    // nothing still returns `true`, so there is no "matched nothing" case here to
    // forgive — `false` means the flag was not set, and saying otherwise leaves
    // the member's mail bold in Gmail while the CRM shows it read.
    if (applied === false) {
      logError('imap-writeback', 'the mail server refused to mark the message read', { mailboxId, uid })
      return { ok: false, reason: 'flag_failed', error: operatorFacingWriteError('transport') }
    }
    return { ok: true, applied: true, uid }
  })
}

/**
 * Clear \Seen on one message — "mark unread", the defer verb of every mail
 * client.
 *
 * 🔴 IT ONLY WORKS BECAUSE IT IS PAIRED, and that is why it lives here rather
 * than as a column write in a route. The poller converges seen_at against the
 * mailbox in BOTH directions, so a CRM-only unread mark is undone within about
 * a quarter of an hour with nothing on screen to explain it. Both halves or
 * neither — see the seen route.
 *
 * SAFER THAN ITS TWIN, NOT RISKIER. Clearing a flag destroys nothing: the
 * message stays exactly where it is and the worst outcome is that head office
 * sees one email go bold again. That is recoverable by reading it. It is the
 * ARCHIVE path that moves mail, and this one deliberately cannot.
 *
 * @returns {Promise<{ok: true, applied: boolean, uid: number}
 *                  |{ok: false, reason: string, error: string}>}
 */
export async function markUnseen(db, mailbox, options = {}) {
  return runWriteback(db, mailbox, options, 'mark_unseen', async ({ client, uid, mailboxId }) => {
    const applied = await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true })
    // Same contract as markSeen: imapflow's STORE returns `true` on success and
    // `false` only from its catch, so `false` is a refusal, never a no-op.
    if (applied === false) {
      logError('imap-writeback', 'the mail server refused to mark the message unread', { mailboxId, uid })
      return { ok: false, reason: 'flag_failed', error: operatorFacingWriteError('transport') }
    }
    return { ok: true, applied: true, uid }
  })
}

/**
 * Move one message out of INBOX and into the provider's Archive folder.
 *
 * 🔴 A MOVE, NEVER A DELETE, AND NEVER AN EXPUNGE. See the header: archive is
 * recoverable and delete is not. `messageMove` issues IMAP MOVE (RFC 6851),
 * which is one atomic server-side operation — as opposed to COPY-then-store-
 * \Deleted-then-EXPUNGE, which is the same thing spelled as three steps, two
 * of which can leave a duplicate or a half-deleted message behind if the
 * connection drops in the middle.
 *
 * The destination is resolved per-mailbox, never hardcoded: see
 * pickArchiveFolder(). A server that cannot say where archived mail goes gets
 * a refusal with a sentence an operator can act on, not a guess at a folder
 * name.
 *
 * @returns {Promise<{ok: true, applied: boolean, uid: number, folder: string, via: string}
 *                  |{ok: false, reason: string, error: string}>}
 */
export async function archiveMessage(db, mailbox, options = {}) {
  return runWriteback(db, mailbox, options, 'archive', async ({ client, uid, credential, mailboxId }) => {
    let boxes = []
    try {
      boxes = await client.list()
    } catch (err) {
      // A LIST we could not do is a transport problem, not "there is no
      // archive folder" — the two need different sentences, so they are not
      // allowed to collapse into one.
      logError('imap-writeback', 'could not list folders to find the archive destination', { mailboxId, err })
      return { ok: false, reason: 'folder_list_failed', error: operatorFacingWriteError('transport') }
    }

    const destination = pickArchiveFolder(boxes, credential?.archive_folder ?? null)
    if (!destination.ok) {
      logWarn('imap-writeback', 'no archive destination could be resolved', {
        mailboxId, reason: destination.reason,
        configured: credential?.archive_folder ?? null,
      })
      return destination
    }

    // 🔴 REFUSE UNLESS THE SERVER REALLY HAS MOVE. This is the guard that keeps
    // this module's central promise true, and without it the promise is FALSE.
    //
    // imapflow does not fail when a server lacks RFC 6851 MOVE — it EMULATES it
    // (commands/move.js): `messageCopy(...)` and then, on the very next line and
    // WITHOUT LOOKING AT THE RESULT, `messageDelete(..., { silent: true })`,
    // which is STORE +FLAGS \Deleted followed by EXPUNGE. So the exact
    // COPY-then-\Deleted-then-EXPUNGE sequence this file's header says does not
    // exist in it happens inside the library, one call down.
    //
    // Two ways that destroys mail rather than filing it:
    //   · a COPY that FAILS returns `false` (commands/copy.js catches and
    //     returns, it does not throw) and the delete runs anyway — the message
    //     is expunged with no copy anywhere. Over quota, an ACL denial or one
    //     transient NO is enough.
    //   · without UIDPLUS the expunge is a BARE `EXPUNGE`, which reaps EVERY
    //     message in INBOX currently flagged \Deleted — including ones a
    //     desktop client marked for deletion and had not yet expunged.
    //
    // Gmail and Microsoft 365 both advertise MOVE, so the live trial is not
    // exposed; the "Other IMAP host" preset is, and this module already expects
    // such servers (ARCHIVE_NAME_FALLBACKS carries 'INBOX.Archive' for a
    // self-hosted Dovecot). A refusal costs an operator a sentence. The
    // alternative costs a customer their mail, silently, reported as success.
    //
    // NEVER answer this by hand-rolling the copy/delete here. There is no
    // version of delete that belongs in this connector.
    if (!client.capabilities?.has('MOVE')) {
      logError('imap-writeback', 'refusing to archive: the server does not support MOVE', {
        mailboxId, folder: destination.path,
      })
      return {
        ok: false,
        reason: 'move_unsupported',
        error: 'This mail server cannot move messages between folders safely, so nothing was changed in the mailbox. The message is archived here.',
      }
    }

    const moved = await client.messageMove(String(uid), destination.path, { uid: true })

    // `false` is a FAILED MOVE, not a no-op — same contract as the STORE in
    // markSeen. A UID that matches nothing still returns a result object, so
    // there is no benign case to fold in here: treating `false` as "somebody
    // archived it already" reported a mailbox that had not been touched as
    // filed, and archive has NO converge path to correct it later.
    if (moved === false) {
      logError('imap-writeback', 'the mail server refused to archive the message', {
        mailboxId, uid, folder: destination.path,
      })
      return { ok: false, reason: 'move_failed', error: operatorFacingWriteError('transport') }
    }

    return {
      ok: true,
      applied: true,
      uid,
      folder: destination.path,
      via: destination.via,
    }
  })
}
