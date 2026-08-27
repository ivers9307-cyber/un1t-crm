// MAILBOX-CONNECT.7 — sending a ticket reply as the CONNECTED address, over
// that mailbox's own SMTP server.
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §4
//
// ── Why this exists at all ────────────────────────────────────────────────
// Postmark cannot DKIM-sign a domain we do not control. Hatch Street's
// accounts@hatchstreetfitness.com is verified because the business owns that
// domain; a SaaS customer connecting hello@theirgym.ie is not, and never will
// be without them doing DNS work for us. Sending their support replies through
// our Postmark account means a From they own, signed by a domain they do not,
// which is the textbook DMARC failure — the message lands in spam or is
// rejected outright, and the operator's only symptom is "members say they
// never got my reply".
//
// Sending over the mailbox's OWN SMTP fixes it at the root rather than
// papering over it: Google (or whoever hosts them) signs the message with the
// domain's own key, SPF and DKIM align with the From, DMARC passes, and the
// reply is byte-for-byte the kind of mail that mailbox already sends every
// day. It is also what makes §5 (mail-client coexistence) tractable — the
// reply lands in the account's real Sent folder, where a human and the Phase 8
// poller can both see it.
//
// ── THE FROM DOES NOT FALL BACK. EVER. (🔴 the rule in this file) ─────────
// The Postmark path in email-inbox-send.js has a deliberate two-attempt plan:
// try the mailbox address, and if Postmark refuses the sender signature, send
// from a domain we own with Reply-To pointing back. That is correct THERE —
// nothing was transmitted on the refusal, and a degraded send beats no send.
//
// It is WRONG here, and silently so. SMTP authenticates AS an account, and
// Google rewrites or rejects a From that is not that account or one of its
// verified aliases; there is no "unverified sender" refusal to catch and no
// second address that would be legitimate. A fallback here would either be
// ignored by the provider (so the customer sees an address we did not choose)
// or would put OUR domain on a reply the member expects from THEIRS. So on
// this path the From is the mailbox's own address or the send fails, loudly,
// with something an operator can act on. plannedFroms() is never called from
// here and must never be.
//
// ── DELIVERY IS NOT TRACKED, AND WE SAY SO ───────────────────────────────
// A Postmark send earns Delivery / Bounce / SpamComplaint webhooks, which mig
// 498 stamps onto the message row. An SMTP send earns nothing: a 250 from the
// submission server means "queued", and any later bounce arrives as an ordinary
// email in the mailbox, not as a callback to us.
//
// mig 498's NULL state means "sent, and we have heard nothing" — which is close
// to the truth here but is NOT the same fact. NULL says an event may still be
// coming; on this path one never is. So the verdict carries
// `deliveryTracked: false` and `result.messageId` is deliberately NULL rather
// than an SMTP id, because the routes write that value straight into
// email_inbox_messages.postmark_message_id — the correlation key a Postmark
// webhook is looked up by. Putting a non-Postmark id in it would claim a
// correlation that cannot exist and would occupy a UNIQUE index for nothing.
// An outbound row with no postmark_message_id is therefore the durable,
// queryable shape of "no provider event can ever arrive for this message",
// and the thread can say "not tracked" from it rather than rendering a pending
// event that is never going to resolve.
//
// ── THE email_sends ROW NEEDS NO REPORTING EXCLUSION. CHECKED, NOT ASSUMED ──
//
// An audit raised this as a live risk: every SMTP send writes an email_sends row
// that can never receive a Delivery event, so an email_administrative delivery
// RATE would quietly degrade as connected mailboxes reply — a metric that starts
// lying rather than data that goes missing. Real-sounding, and worth resolving
// before someone "fixes" it by filtering rows out of a surface that never
// counted them. Every consumer of email_sends was traced 2026-08-27:
//
//   • communications hub stats — filters `.eq('postmark_stream','broadcast')`.
//     Ticket replies write TICKET_INTERNAL_STREAM ('outbound'), so they were
//     ALREADY outside every rate on that surface, by rule rather than accident.
//   • campaign + sequence stats — scoped by campaign_id / sequence_id. A ticket
//     reply belongs to neither and cannot enter the denominator.
//   • the contact timeline (emailStatusPill) — falls through to **"Sent"** when
//     delivered_at is null, which is exactly true of an SMTP send. It reads
//     honestly with no change.
//   • bounce-escalation — treats delivered_at as EVIDENCE that overrides a
//     bounce. Absence of evidence withholds an override; it never invents one.
//     Conservative in the safe direction.
//   • usage rollups — count volume, not delivery.
//
// So there is nothing to exclude, and excluding would be the worse move: it
// would hide real sends from surfaces that either already omit them or display
// them accurately. The row stays. `postmark_message_id IS NULL` is a reliable
// discriminator on this path if a FUTURE rate ever needs to segment (the id is
// minted by Postmark and the row is written after the API returns, so a
// Postmark ticket send always has one) — but do not spend it on a problem that
// does not exist yet.
//
// ── AT-LEAST-ONCE, NOT EXACTLY-ONCE: THE DUPLICATE WINDOW ─────────────────
//
// SMTP has no way to make this exactly-once, and pretending otherwise would be
// worse than naming it. If the connection dies AFTER the submission server has
// accepted DATA but BEFORE its 250 reaches us, nodemailer throws, this function
// answers `send_failed`, the route answers 400 and writes NOTHING — no
// email_inbox_messages row, no email_sends row. The member has the reply. The
// operator sees a failure and presses Send again, and now the member has it
// twice.
//
// It is NOT guarded, deliberately. The alternatives are worse:
//   • A claim/lease taken BEFORE the send converts a possible duplicate into a
//     permanent SILENT LOSS whenever the process dies mid-send — CLAUDE.md's
//     rule, learned four times over on BAREWRITE: for a customer-facing message,
//     losing it is worse than the rare duplicate the guard was added to prevent.
//   • Recording the send optimistically and reconciling later needs a signal to
//     reconcile against, and this path has none by construction — that is the
//     entire subject of the block above.
//
// Phase 8's Sent-folder lane narrows it in practice without being designed to:
// the copy the provider kept lands back in the CRM on the next poll, so a
// duplicate becomes VISIBLE in the thread within about five minutes even though
// it was not prevented. That is a mitigation, not a fix, and it only helps a
// mailbox with a sent_folder configured.
//
// If this ever needs closing properly, the shape is a lease column something
// later re-opens (the WhatsApp drip claim is the estate's worked example), not
// a pre-send stamp.
//
// ── Fail-safe shape ───────────────────────────────────────────────────────
// NOTHING HERE THROWS. Same verdict envelope as sendTicketEmail, because this
// IS one of sendTicketEmail's two branches and the routes must not be able to
// tell which one ran:
//   { ok: true,  result, fromEmail, degraded, deliveryTracked }
//   { ok: false, reason: 'not_configured'|'send_failed', error }
// The two reasons are not interchangeable — the routes answer 503 for the
// first and 400 for the second (see the docblock on sendTicketEmail) — so the
// split below is by "is this about the deployment/config, or about this
// particular message", not by where the error happened to be thrown.
import nodemailer from 'nodemailer'
import { createServerClient } from '../supabase'
import { logError, logWarn } from '../log'
import { resolveFreshAuth } from './oauth-tokens.js'

/**
 * Timeouts, deliberately far below nodemailer's defaults (2min connect /
 * 30s greeting / 10min socket).
 *
 * A ticket reply is sent inside a user-facing request: an operator clicks
 * Send and waits. Two minutes staring at a spinner because the customer's
 * SMTP host is unreachable is not an outcome anyone should get — a fast, clear
 * failure they can retry is. These mirror src/lib/mail/imap-connection.js so
 * one mailbox behaves the same on both legs.
 */
const CONNECTION_TIMEOUT_MS = 20_000
const GREETING_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 60_000

/** Longest error string we hand back — it is rendered to an operator. */
const MAX_ERROR_CHARS = 500

/**
 * The credential columns this file needs, named explicitly.
 *
 * No `select('*')` on a credentials table, for the same reason there is none
 * on email_mailboxes anywhere in this repo: a narrow list is the only thing
 * that keeps a column added later from silently arriving in a payload nobody
 * audited. It also documents, in one line, exactly which secrets this code
 * path is allowed to touch.
 */
const CREDENTIAL_COLUMNS = [
  // 🔴 MAILBOX-OAUTH.5 — `provider` and `oauth_refresh_token_ciphertext` are
  // here because resolveFreshAuth needs both to renew a spent access token:
  // the first says WHICH identity service to ask, the second is what it is
  // asked with. Dropping either does not break loudly — it makes every OAuth
  // mailbox stop sending about an hour after it was connected, reporting an
  // expired sign-in that no operator action can clear.
  'mailbox_id', 'provider', 'auth_type', 'username',
  'secret_ciphertext',
  'oauth_access_token_ciphertext', 'oauth_refresh_token_ciphertext', 'oauth_expires_at',
  'smtp_host', 'smtp_port', 'smtp_secure',
].join(', ')

/**
 * An error message safe to store and to show an operator.
 *
 * Same two jobs as safeError() in imap-connection.js, and deliberately a
 * second copy rather than an import: that one is not exported, and the shape
 * of what leaks differs per library. (1) REDACT — nodemailer's EAUTH errors
 * quote the server's response, and some servers echo the AUTH argument back;
 * an app password reaching an operator-facing string is a credential in a
 * screenshot forever. (2) CAP — an SMTP server can answer with a multi-line
 * rejection of arbitrary length.
 *
 * @param {unknown} err
 * @param {{pass?: string, accessToken?: string}} [auth]  the secrets to scrub
 */
export function safeSmtpError(err, auth) {
  const raw = String(err?.response || err?.message || err || 'unknown error')
  let out = raw
  for (const secret of [auth?.pass, auth?.accessToken]) {
    // Short strings are skipped: scrubbing a 2-character "password" would
    // shred an otherwise readable message into [redacted] confetti.
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[redacted]')
    }
  }
  return out.slice(0, MAX_ERROR_CHARS)
}

/**
 * Adapt auth-strategy.js's transport-neutral verdict to the shape nodemailer
 * actually reads.
 *
 * 🔴 VERIFIED AGAINST NODEMAILER 9.0.5's SOURCE, because the cross-phase
 * contract's claim that "both imapflow and nodemailer accept either object
 * shape verbatim" is HALF TRUE and the false half is the dangerous one.
 *
 *   imapflow — true. imap-flow.js branches on `if (this.options.auth
 *   .accessToken)`, so `{ user, accessToken }` selects XOAUTH2 by itself.
 *
 *   nodemailer — FALSE. lib/smtp-transport/index.js `getAuth()` switches on
 *   `(authData.type || '').toUpperCase()`, and ONLY the `'OAUTH2'` case builds
 *   the XOAuth2 helper that lib/smtp-connection/index.js `login()` looks for
 *   (`if (!this._authMethod && this._auth.oauth2 …)`). With no `type`, every
 *   other shape falls into the default branch, which reads `authData.pass` and
 *   IGNORES `accessToken` entirely. Measured:
 *     { user, accessToken }              → { type:'LOGIN', credentials:{ user } }
 *     { type:'OAuth2', user, accessToken } → { type:'OAUTH2', method:'XOAUTH2' }
 *   The first then fails at login with EAUTH "Missing credentials for PLAIN".
 *   Loud rather than silent, but a whole auth mode that simply does not work.
 *
 * The adaptation lives HERE rather than in auth-strategy.js on purpose: that
 * module's verdict is the OAuth *seam*, shared by the IMAP poller, the connect
 * route and this sender, and it must stay a statement about the CREDENTIAL
 * rather than about any one library's option parser. Teaching it nodemailer's
 * `type` key would put a transport detail in the one place that is supposed to
 * have none, and imapflow would then have to strip it back off.
 *
 * The password shape passes through untouched — nodemailer's default branch
 * reads `{ user, pass }` exactly as imapflow does — so this is a no-op today
 * and the whole OAuth branch is dead code until Phase §2.1 ships. It exists so
 * that when OAuth does ship, the thing that has to be right is already written
 * down and tested rather than discovered against a live customer mailbox.
 *
 * @param {{user: string, pass?: string, accessToken?: string}} auth
 * @returns {object} nodemailer `auth` options
 */
export function adaptAuthForNodemailer(auth) {
  if (auth && typeof auth.accessToken === 'string' && auth.accessToken) {
    // No refreshToken / clientId / serviceClient is supplied, so nodemailer's
    // XOAuth2 helper cannot mint a new token — it reuses this one and reports
    // an error if it is rejected. That is exactly right, and MAILBOX-OAUTH.5
    // made it more so rather than less: renewal happens in
    // src/lib/mail/oauth-tokens.js, ABOVE this call, where the rotated refresh
    // token is sealed and written back. A refresh performed down here would
    // leave the database holding a token we had silently replaced — and
    // nodemailer would do it per transport, so two concurrent replies would
    // race to mint tokens neither of them stored.
    return { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
  }
  return auth
}

/**
 * Postmark's header array → nodemailer's.
 *
 * Both are "a list of custom headers" and they are NOT interchangeable.
 * Postmark uses `[{ Name, Value }]`; nodemailer's mime-node addHeader() reads
 * `[{ key, value }]` and, given the Postmark shape, happily pushes
 * `{ key: undefined, value: undefined }` for every entry — producing a message
 * whose In-Reply-To and References are gone. The reply still sends, so nothing
 * fails; it just silently starts a new thread in the member's mail client and
 * opens a duplicate ticket when they answer. Threading is the entire reason
 * these headers exist, so the mapping is explicit and tested.
 *
 * Entries without a usable name are dropped rather than passed through — a
 * header with an undefined key is not a header.
 */
export function toNodemailerHeaders(headers) {
  if (!Array.isArray(headers) || !headers.length) return undefined
  const out = headers
    .filter(h => h && typeof h.Name === 'string' && h.Name.trim())
    .map(h => ({ key: h.Name.trim(), value: h.Value == null ? '' : String(h.Value) }))
  return out.length ? out : undefined
}

/**
 * Postmark's attachment array → nodemailer's.
 *
 * FIELD BY FIELD, NEVER A SPREAD. nodemailer treats `path` as a local file to
 * read and `href` as a URL to fetch, both at send time, both from the same
 * object literal as `content`. Spreading a caller-supplied attachment into it
 * would turn any future path that lets a user influence that object into
 * arbitrary local-file exfiltration or SSRF, with the stolen bytes attached to
 * an email the attacker chose the recipient of. The three Postmark fields are
 * the only three that cross, so only those three are written.
 *
 * `Content` is base64 (that is Postmark's wire format and what
 * collectOutboundAttachments produces), so `encoding: 'base64'` is stated
 * rather than left to nodemailer's detection.
 */
export function toNodemailerAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined
  const out = attachments
    .filter(a => a && typeof a.Content === 'string')
    .map(a => ({
      filename: typeof a.Name === 'string' ? a.Name : 'attachment',
      content: a.Content,
      encoding: 'base64',
      contentType: typeof a.ContentType === 'string' ? a.ContentType : undefined,
    }))
  return out.length ? out : undefined
}

/**
 * An RFC 5322 Message-ID in the BARE form this codebase stores everywhere.
 *
 * The convention is set by extractRfcMessageId() → parseMessageIdTokens()
 * in src/lib/email-inbox.js, which strips the angle brackets off every
 * INBOUND id before it reaches email_inbox_messages.rfc_message_id, and off
 * every In-Reply-To/References token before the webhook matches on it. An
 * outbound id stored bracketed is therefore invisible to threading — the
 * comparison is plain string equality in a PostgREST `.in()`.
 *
 * Deliberately duplicated rather than imported: parseMessageIdTokens is
 * module-private to email-inbox.js, and this file is a transport that should
 * not take a dependency on the inbound parser to normalise one string. The
 * rule it mirrors is one line long and is named above so the two cannot
 * silently diverge without someone reading this comment.
 *
 * @param {string|null|undefined} value nodemailer's info.messageId, e.g. `<x@y>`
 * @returns {string|null} `x@y`, or null when there is nothing usable
 */
export function bareMessageId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const angled = trimmed.match(/<([^<>]+)>/)
  const bare = (angled ? angled[1] : trimmed).trim()
  if (!bare) return null
  // Anything with a bracket still in it is not an id we can thread on — `<>`
  // is the reachable case (the capture needs at least one character, so it
  // falls through as the literal string). parseMessageIdTokens has the same
  // hole and would hand back the same junk, so this is NOT a divergence from
  // the convention: it is refusing to write a value that could never match
  // anything. NULL is the honest answer, and the column is nullable.
  return /[<>]/.test(bare) ? null : bare
}

/** Failure verdict, in sendTicketEmail's envelope. */
function fail(reason, error) {
  return { ok: false, reason, error }
}

/**
 * Build the nodemailer transport options for a credential row.
 *
 * `secure` is read as `!== false` for the same reason imap-connection.js reads
 * it that way: an absent column must mean implicit TLS, not cleartext.
 *
 * `requireTLS` is the part that is NOT just mirroring. With `secure: false`
 * (submission on 587) nodemailer will use STARTTLS *if the server offers it*
 * and will otherwise carry on in the clear — so a misconfigured or
 * downgrade-attacked host would send a customer's correspondence, and their
 * mailbox password, across the internet unencrypted, and the send would look
 * completely successful. requireTLS turns that into a refusal.
 */
function transportOptions({ host, port, secure, auth }) {
  const explicitlyInsecure = secure === false
  return {
    host,
    port: port ?? 465,
    secure: !explicitlyInsecure,
    // Only meaningful when `secure` is false; harmless otherwise.
    requireTLS: explicitlyInsecure,
    auth: adaptAuthForNodemailer(auth),
    // Never log. nodemailer's debug logger prints the SMTP conversation,
    // which includes the base64 AUTH argument — i.e. the customer's password
    // (§6). `logger: false` is the default; it is stated because a future
    // debugging session that flips it on must be a visible decision.
    logger: false,
    debug: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  }
}

/**
 * Live connect + EHLO + AUTH check, for the connect screen (Phase 6 verifies
 * BEFORE persisting a credential — an inbox that cannot log in is worse than
 * no inbox, because it sits there failing in silence).
 *
 * NEVER THROWS, for the same reason verifyConnection() in imap-connection.js
 * does not: the thing on the other end is a person typing a password into a
 * form, and "Invalid login: 535-5.7.8 Username and Password not accepted" is
 * an answer they can act on where a 500 is not.
 *
 * Deliberately mirrors verifyConnection's signature — `{ host, port, secure,
 * auth }` with `auth` straight off resolveAuth() — so the connect route
 * verifies both legs of a mailbox with two structurally identical calls.
 *
 * @param {{host: string, port?: number, secure?: boolean, auth: object}} config
 * @param {{createTransport?: Function}} [deps]  test seam ONLY; production
 *   callers pass nothing. Separate trailing argument so `config` stays exactly
 *   the credential-row shape the routes build.
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function verifySmtpConnection({ host, port, secure, auth }, deps = {}) {
  const createTransport = deps.createTransport || ((opts) => nodemailer.createTransport(opts))
  if (!host || typeof host !== 'string' || !host.trim()) {
    return { ok: false, error: 'No SMTP host is configured for this mailbox.' }
  }
  let transport = null
  try {
    transport = createTransport(transportOptions({ host: host.trim(), port, secure, auth }))
    await transport.verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: safeSmtpError(err, auth) }
  } finally {
    // Always release the socket, exactly as withMailbox() always logs out.
    // Swallowed: a close that fails must never turn a good verify into a bad
    // one, nor replace a real diagnosis with "connection closed".
    try { transport?.close?.() } catch { /* nothing to do about it */ }
  }
}

/**
 * Send one ticket email over the mailbox's own SMTP server.
 *
 * NEVER THROWS. Returns sendTicketEmail's verdict envelope, plus one extra key
 * on success:
 *
 *   { ok: true, result, fromEmail, degraded: null, deliveryTracked: false }
 *   { ok: false, reason: 'not_configured', error }  — nothing was attempted;
 *       the deployment or the mailbox's own configuration is the problem, the
 *       retry after fixing it is exact, and the routes answer 503.
 *   { ok: false, reason: 'send_failed', error }     — the server refused THIS
 *       message (bad credentials, rejected recipient, size, rate limit). The
 *       routes answer 400 and write nothing, exactly as for a Postmark refusal.
 *
 * `degraded` is ALWAYS null here and that is the point: degradation on the
 * Postmark path means "we sent from a different address than you asked for",
 * and this path has no such move (see the From rule in the header). Reporting
 * anything else would be reporting a fallback that did not happen.
 *
 * `tag` and `metadata` are NOT parameters. Both are Postmark concepts —
 * `metadata` in particular carries POSTMARK-RACE.1's send marker, which exists
 * so a Delivery webhook arriving before the email_sends row can be matched
 * later. There are no webhooks on this path, so carrying them would be
 * inventing bookkeeping for events that never happen. sendTicketEmail drops
 * them at the branch; that is deliberate and documented there.
 *
 * @param {object} args
 * @param {{id: string, address: string}} args.mailbox  the email_mailboxes row
 *   (its `egress` has already selected this path).
 * @param {{db?: object, createTransport?: Function, now?: () => Date}} [deps]
 *   test seam ONLY.
 */
export async function sendViaSmtp({
  mailbox, to, cc, bcc, subject, htmlBody, textBody, headers, attachments,
}, deps = {}) {
  const fromEmail = typeof mailbox?.address === 'string' ? mailbox.address.trim() : ''
  if (!mailbox?.id || !fromEmail) {
    // Unreachable through the ticket routes (a mailbox row always has both),
    // but this is the guard that makes "the From never falls back" true by
    // construction rather than by inspection: with no address there is nothing
    // legitimate to send as, so the answer is a refusal and not a substitution.
    return fail(
      'not_configured',
      'This mailbox is set to send over SMTP but has no address to send as. Nothing was sent.'
    )
  }

  const db = deps.db || createServerClient()

  // ── The credential ──────────────────────────────────────────────────
  // maybeSingle(), and the error is INSPECTED rather than collapsed into
  // "no credential". A failed lookup and an unconfigured mailbox are opposite
  // facts with the same `data === null`, and the CLAUDE.md invariant about
  // discarded .single() errors is precisely about not letting them merge:
  // "the database blipped" told to an operator as "you have not connected this
  // mailbox" sends them to a settings screen that is already correct.
  let credential = null
  try {
    const { data, error } = await db.from('email_mailbox_credentials')
      .select(CREDENTIAL_COLUMNS)
      .eq('mailbox_id', mailbox.id)
      .maybeSingle()
    if (error) {
      logError('mail/smtp-send', 'credential lookup failed BEFORE sending', {
        mailboxId: mailbox.id, error: error.message,
      })
      // not_configured, not send_failed: nothing was transmitted, the fault is
      // not this message's, and 503 ("try again") is the honest answer for a
      // read we could not complete.
      return fail(
        'not_configured',
        'Could not read this mailbox’s send settings, so nothing was sent. Nothing has changed — try again.'
      )
    }
    credential = data
  } catch (err) {
    // A thrown client (bad env, no network to Supabase) must not escape: this
    // function's contract is a verdict, and the routes have no catch.
    logError('mail/smtp-send', 'credential lookup threw BEFORE sending', {
      mailboxId: mailbox.id, error: err?.message || String(err),
    })
    return fail(
      'not_configured',
      'Could not read this mailbox’s send settings, so nothing was sent. Nothing has changed — try again.'
    )
  }

  if (!credential) {
    return fail(
      'not_configured',
      'This mailbox is set to send over SMTP but no mail account is connected to it. Connect it in Settings → Email, then try again.'
    )
  }

  const host = typeof credential.smtp_host === 'string' ? credential.smtp_host.trim() : ''
  if (!host) {
    // The IMAP half can be connected without the SMTP half — imap_host is NOT
    // NULL in the schema and smtp_host is nullable, so this is a real state a
    // receive-only mailbox sits in, not a corruption.
    return fail(
      'not_configured',
      'This mailbox is set to send over SMTP but has no outgoing (SMTP) server configured. Add one in Settings → Email, then try again.'
    )
  }

  // The OAuth seam. Verdicts other than `not_configured` (decrypt_failed,
  // oauth_expired, oauth_revoked, oauth_refresh_failed, provider_unavailable,
  // unsupported_auth_type) are all mapped onto `not_configured` HERE rather
  // than widening sendTicketEmail's envelope: they are the same KIND of thing
  // from the route's point of view — nothing was attempted, the fault is in
  // the stored configuration, retry once it is fixed — and the envelope is a
  // contract three routes already branch on. The verdict's own sentence is
  // carried through verbatim, so the operator still sees which one it was, and
  // "sign in again" and "the provider could not be reached" read differently on
  // the screen even though the envelope cannot tell them apart. It never
  // contains the secret (that is a guarantee of auth-strategy.js and
  // oauth-tokens.js, not an accident of this call).
  //
  // MAILBOX-OAUTH.5 — resolveFreshAuth rather than resolveAuth, so an operator
  // hitting Send on a mailbox that has been idle past its token's lifetime
  // gets a renewal instead of a refusal. A password mailbox is unaffected: the
  // wrapper's first branch hands it straight to resolveAuth. This is the one
  // send-path call that can now make a network request before the SMTP dial,
  // which is why the refresh carries its own 15-second timeout — an operator
  // is watching a spinner.
  const verdict = await resolveFreshAuth(db, credential)
  if (!verdict.ok) return fail('not_configured', verdict.error)

  const auth = verdict.auth

  // ── The send ────────────────────────────────────────────────────────
  const createTransport = deps.createTransport || ((opts) => nodemailer.createTransport(opts))
  const now = deps.now ? deps.now() : new Date()
  let transport = null
  try {
    transport = createTransport(transportOptions({
      host,
      port: credential.smtp_port,
      secure: credential.smtp_secure,
      auth,
    }))

    // Every field is named. Nothing caller-supplied is spread into these
    // options — see toNodemailerAttachments for what a spread would let in.
    const info = await transport.sendMail({
      // 🔴 THE MAILBOX ADDRESS, FULL STOP. No plannedFroms(), no fallback,
      // no POSTMARK_FROM_EMAIL. See the header.
      from: fromEmail,
      // to/cc/bcc arrive as the comma-separated wire strings
      // toPostmarkFields() produced (EMAIL-CC.1 owns recipient policy; this
      // file owns transport). nodemailer parses that form natively, so they
      // are passed through unsplit and unjoined — re-deriving them here would
      // create a second site where a resolved recipient set becomes wire
      // values, which is the thing that makes the Bcc guarantee auditable.
      // `bcc` reaches SMTP's RCPT TO and no header, exactly as it reaches
      // Postmark's Bcc field and no header.
      to: to || undefined,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject,
      text: textBody || undefined,
      html: htmlBody || undefined,
      // NO Reply-To. On the Postmark path it is set unconditionally because
      // the From may have fallen back to a domain we own; here the From IS the
      // mailbox, so a Reply-To would be the same address twice — noise in the
      // headers that suggests a redirection that is not happening.
      headers: toNodemailerHeaders(headers),
      attachments: toNodemailerAttachments(attachments),
    })

    // nodemailer throws EENVELOPE when EVERY recipient is rejected, so this is
    // belt-and-braces — but the alternative to checking is reporting a
    // successful send of a message that reached nobody, and this module's
    // whole job is that the routes cannot tell which transport ran.
    const accepted = Array.isArray(info?.accepted) ? info.accepted : []
    const rejected = Array.isArray(info?.rejected) ? info.rejected : []
    if (!accepted.length) {
      return fail(
        'send_failed',
        'The mail server accepted none of the recipients, so nothing was delivered.'
      )
    }
    if (rejected.length) {
      // A PARTIAL send: the accepted recipients have it and resending would
      // double-send them, so this is not a failure — it is a fact somebody
      // needs. Counts only, no addresses: logError's meta is PII-free.
      logWarn('mail/smtp-send', 'some recipients were rejected by the mail server', {
        mailboxId: mailbox.id, accepted: accepted.length, rejected: rejected.length,
      })
    }

    return {
      ok: true,
      result: {
        // 🔴 NULL ON PURPOSE — see DELIVERY IS NOT TRACKED in the header. The
        // routes write this into email_inbox_messages.postmark_message_id and
        // email_sends.postmark_message_id, which are Postmark's own GUID and
        // the key its webhooks correlate on. Both columns are nullable and the
        // UNIQUE index on the first is partial (WHERE NOT NULL), so leaving it
        // empty is a supported state — and it is the state that means "no
        // provider event will ever arrive for this row".
        messageId: null,
        // The real RFC 5322 Message-ID nodemailer minted and put in the header,
        // BARE — brackets stripped. Two things read this and both need the bare
        // form:
        //
        //   1. THREADING. The three ticket routes write it to
        //      email_inbox_messages.rfc_message_id, and the inbound webhook
        //      resolves a thread with `.in('rfc_message_id', candidates)` where
        //      the candidates come from parseMessageIdTokens() — which strips
        //      the brackets (src/lib/email-inbox.js:56-62). Every inbound row
        //      is stored bare too, via extractRfcMessageId(). Storing the
        //      bracketed form would match NEITHER column (postmark_message_id
        //      is deliberately NULL here), so every customer reply to an
        //      SMTP-sent message would open a BRAND NEW TICKET while the
        //      original sat unanswered. Caught by audit; the whole reason these
        //      six write sites exist is to prevent exactly that.
        //   2. §5's Sent-folder dedupe, which compares our own sends against
        //      polled mail whose ids arrive through the same bare-form parse.
        //
        // nodemailer returns it WITH brackets — mime-node's
        // _generateMessageId() builds '<' + … + '@' + domain + '>' and
        // info.messageId is that header value verbatim. So the strip is
        // load-bearing, not defensive tidying.
        rfcMessageId: bareMessageId(info?.messageId),
        // Shape-parity with sendEmail()'s { messageId, to, submittedAt } so a
        // caller reading the verdict does not have to know which branch ran.
        to: accepted.join(', '),
        submittedAt: now.toISOString(),
        accepted,
        rejected,
        // The submission server's own 250 line — usually carries its queue id,
        // which is the only handle anyone has when chasing a message that was
        // accepted and then vanished.
        response: info?.response || null,
      },
      fromEmail,
      // Never anything else on this path. See the docblock.
      degraded: null,
      // The honest half of the delivery story. Present ONLY on this branch:
      // the Postmark verdict is left byte-identical to what it has always
      // been, so `deliveryTracked === false` means "SMTP, no events coming"
      // and its absence means the Postmark path, which does get events.
      deliveryTracked: false,
    }
  } catch (err) {
    // Redacted before it goes anywhere. This string is returned to the route,
    // rendered to the operator, and may end up in a screenshot.
    const error = safeSmtpError(err, auth)
    logError('mail/smtp-send', 'SMTP send failed', {
      mailboxId: mailbox.id,
      // nodemailer's own classification (EAUTH / EENVELOPE / ECONNECTION /
      // ETIMEDOUT), which is what tells a revoked app password apart from an
      // unreachable host. Never the message — that is redacted above and has
      // no business being logged twice.
      code: err?.code || null,
    })
    return fail('send_failed', error)
  } finally {
    try { transport?.close?.() } catch { /* nothing to do about it */ }
  }
}
