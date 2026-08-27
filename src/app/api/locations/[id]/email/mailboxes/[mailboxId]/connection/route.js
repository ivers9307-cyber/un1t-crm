// MAILBOX-CONNECT.6 — the login one email account receives on.
//
// GET    /api/locations/[id]/email/mailboxes/[mailboxId]/connection
//   Connection STATE plus per-folder poll health. Never the credential.
// PUT    …/connection
//   Connect the account, or change its settings/password. Verifies the login
//   against the real IMAP server — and the real SMTP server when one is
//   supplied — BEFORE anything is written.
// DELETE …/connection
//   Disconnect: destroy the credential, stop the poller, put the account back
//   on Postmark for both directions.
//
// WHY THIS EXISTS
// mig 485 gave a studio many inbound addresses but exactly one way in: the
// Postmark inbound webhook, which needs the domain's MX pointed at Postmark,
// which needs owning the domain. `un1t.com` is the franchisor's and always
// will be. Holding the mailbox LOGIN is the requirement that was actually
// needed, and this route is where an operator supplies it. Full reasoning in
// docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md.
//
// ── THE GATE ────────────────────────────────────────────────────────────────
// guardMailboxAdmin — master or owner-at-location, the SAME gate as mailbox
// grants (../../_helpers.js has the argument). A MANAGER HOLDS `email_inbox`
// AND IS NOT ELEVATED, so gating on the surface permission would let a manager
// connect a login to `accounts@` and, in doing so, hand themselves the
// studio's billing correspondence from a screen they were never meant to
// reach. Whoever may grant access to a mailbox is exactly whoever may connect
// one.
//
// 🔴 THERE IS NO LINTER BEHIND THIS ONE. Neither email_mailbox_credentials nor
// email_mailbox_ingress carries a location_id — the mailbox holds it — so
// `check:location-scoping` does not classify them as tenant tables and would
// stay silent on a handler that read either one unscoped. The scoping is
// therefore deliberate, in two places and no others: the guard above, and
// loadMailboxOr404, which resolves the mailbox with .eq('location_id', …) and
// answers 404 (never 403) so another studio's mailbox ids stay unenumerable.
// Every query below keys off `params.mailboxId` only AFTER that load has
// proven the mailbox belongs to this location. Do not add a read here that
// runs before it.
//
// ── VERIFY BEFORE PERSIST ───────────────────────────────────────────────────
// The login is proven against the live servers — IMAP always, SMTP too when
// an outgoing server was supplied — before a single row is written, mirroring
// src/app/api/accounting/mailboxes/route.js:69. An inbox that cannot
// authenticate is worse than no inbox: it sits there failing every five
// minutes, the operator believes their mail is arriving, and the only signal
// is a health row nobody has opened. A typo must fail in the form, while the
// person who made it is still looking at it.
//
// ── PUT DIALS A HOST THE CALLER CHOSE ───────────────────────────────────────
// Which makes it an SSRF surface held by a customer-tier role. The host must
// resolve public, the port must be a mail port, and the failure the caller sees
// is a category rather than the remote server's own bytes — see the block above
// ConnectionBody, which also states the residual (a DNS-rebinding TOCTOU this
// file cannot close on its own).
//
// ── THE SECRET IS WRITE-ONLY ────────────────────────────────────────────────
// No GET in this file — or anywhere else — selects `secret_ciphertext` or any
// `oauth_*` column. CONNECTION_STATE_COLUMNS below is the allowlist that makes
// that structural rather than remembered, and the ONE read that names the
// secret (in PUT, to carry a stored password forward when only the host
// changed) never lets the value reach a response, a log line or an audit row.
// The UI renders connection state, never the value.

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logAuditEvent } from '@/lib/audit'
import { logError, logWarn } from '@/lib/log'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { isFreshSecret } from '@/lib/integration-secret-merge'
import { isConfigured, seal } from '@/lib/mail/secret-box'
import { resolveAuth } from '@/lib/mail/auth-strategy'
import { oauthProviderCatalogue } from '@/lib/mail/oauth-providers'
import { verifyConnection } from '@/lib/mail/imap-connection'
import { verifySmtpConnection } from '@/lib/mail/smtp-send'
import {
  guardMailboxAdmin, mailboxUnauthorized, loadMailboxOr404,
  MAX_CONNECTED_MAILBOXES_PER_LOCATION,
} from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'email-mailbox-connection'

// 🔴 THE ALLOWLIST. `secret_ciphertext`, `oauth_access_token_ciphertext`,
// `oauth_refresh_token_ciphertext` and `oauth_expires_at` are ABSENT and must
// stay absent — this string is what every read path outside the PUT handler
// projects, so a column added to the table cannot reach a response without an
// edit here. Written out rather than select('*') for exactly that reason; the
// same discipline the Shelly connection route applies to its auth key, and for
// the same stake (an IMAP app password is total mailbox authority — read
// everything, send as them).
const CONNECTION_STATE_COLUMNS =
  'mailbox_id, provider, auth_type, username, imap_host, imap_port, imap_secure, ' +
  'smtp_host, smtp_port, smtp_secure, sent_folder, created_by, created_at, updated_at'

// The poll cursor + health for each folder. `uidvalidity`/`last_uid` are
// included because "anchored, waiting for new mail" and "never anchored" are
// different states to an operator staring at a mailbox that has produced no
// tickets yet, and only the cursor can tell them apart.
const INGRESS_COLUMNS =
  'mailbox_id, folder, uidvalidity, last_uid, last_run_at, last_ok_at, last_error, ' +
  'consecutive_failures, paused_until'

// One row per polled folder per mailbox — 'inbox' today, plus 'sent' when
// Phase 8 lands. The bound is stated rather than left to the 1,000-row cap.
const FOLDER_LIMIT = 20

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

/**
 * The operator-facing view of a credential row. Takes ONLY the state columns —
 * it is never handed a row that carries the secret, and it never invents a
 * masked echo of one either. There is nothing to echo: the password is stored
 * as ciphertext we deliberately cannot cheaply unwrap for display, and a
 * "••••abcd" hint would leak the last four characters of a live app password
 * to every owner-shaped session. The row EXISTING is the whole truth the UI
 * needs — a credential row is only ever written after a live login succeeded,
 * so "connection is not null" means "there is a password here that worked",
 * which is what drives "leave blank to keep the current password".
 */
function connectionView(row) {
  if (!row) return null
  return {
    provider: row.provider,
    auth_type: row.auth_type,
    username: row.username,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    imap_secure: row.imap_secure,
    smtp_host: row.smtp_host ?? null,
    smtp_port: row.smtp_port ?? null,
    smtp_secure: row.smtp_secure,
    sent_folder: row.sent_folder ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/**
 * `provider` drives the settings-UI preset, not the auth mechanism (auth_type
 * does that). 'microsoft' is accepted by the CHECK on the column and refused
 * on THIS route: Exchange Online turned off basic-auth IMAP, so a Microsoft
 * account cannot be connected with a password at all.
 *
 * 🔴 MAILBOX-OAUTH.6 — THIS REFUSAL IS NOW A SIGNPOST, NOT A DEAD END. It used
 * to say the release did not include a Microsoft sign-in. It does: see
 * …/oauth/start. Leaving the old sentence standing would be worse than never
 * having written it — an operator would read "not supported yet" three
 * centimetres above the button that supports it. A retracted limitation is
 * rewritten, not softened (the same call MAILBOX-COEXIST.1 made when Phase 8
 * made its own warning false).
 */
const MICROSOFT_REFUSAL =
  'Microsoft 365 and Outlook accounts cannot be connected with a password — Exchange Online no ' +
  'longer allows one over IMAP. Use “Sign in with Microsoft” on this account instead; it is on ' +
  'this same screen and it is the only way in for these accounts.'

/**
 * MAILBOX-OAUTH.6 — refusing to overwrite a Microsoft sign-in with a password.
 *
 * Not a safety rail, an honesty one. This route writes `auth_type: 'password'`
 * unconditionally, so a save on an OAuth-connected mailbox would replace a live
 * OAuth grant with a password — and for Exchange Online that password cannot
 * work, so the mailbox would go from receiving to silently failing on the next
 * tick. The operator's own action would break it and nothing on the way there
 * would have said so.
 *
 * Disconnect is the deliberate way out, and it says so: it deletes the stored
 * grant, which is the thing that ought to happen before a mailbox changes how
 * it authenticates.
 */
const OAUTH_ALREADY_CONNECTED_REFUSAL =
  'This account is connected with a provider sign-in, not a password. Saving a password here would ' +
  'replace that sign-in with one the provider will refuse, and mail would stop arriving. Press ' +
  'Disconnect first if you really want to switch it to a password.'

const ConnectionBody = z.object({
  provider: z.enum(['gmail', 'microsoft', 'custom']).optional().default('custom'),
  // 320 = the RFC's practical local@domain ceiling; the username is USUALLY
  // the address but is not structurally required to be (mig 572's column
  // comment) — some hosts authenticate on a separate account name.
  username: z.string().min(3).max(320),
  // Optional on purpose. The form renders the password blank on an already
  // connected account, so a save that only changed the host must carry the
  // stored secret forward rather than wipe it (the Glofox null-collapse trap
  // that src/lib/integration-secret-merge.js exists for).
  password: z.string().max(512).optional(),
  imap_host: z.string().min(3).max(255),
  imap_port: z.number().int().min(1).max(65535).optional().default(993),
  imap_secure: z.boolean().optional().default(true),
  smtp_host: z.string().max(255).nullable().optional(),
  smtp_port: z.number().int().min(1).max(65535).nullable().optional(),
  smtp_secure: z.boolean().optional().default(true),
  sent_folder: z.string().max(255).nullable().optional(),
})

/** '' → null, so a cleared optional field reads as absent rather than empty. */
const orNull = (value) => {
  if (value == null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

// ── WHERE THIS ROUTE IS ALLOWED TO DIAL ─────────────────────────────────────
// MAILBOX-CONNECT.8. PUT opens a TCP connection to an operator-supplied
// host:port from inside the Vercel function, and until this block existed it
// would open one to ANY of them: `imap_host` was `z.string().min(3).max(255)`
// and the port was 1-65535. That is a server-side request forgery primitive
// with a response oracle, held by a CUSTOMER-tier role — an owner is a paying
// tenant, not a platform operator. What is reachable from a serverless egress
// is not nothing: the cloud metadata endpoint (169.254.169.254), anything on a
// peered private network, and every other SaaS the function can see. The old
// failure message then handed back the remote server's own bytes
// (`err.responseText` / `err.response`), which is what turned "can I connect"
// into "what is listening, and what does it say".
//
// Three things close it and none of them alone is enough:
//   1. the PORT must be a mail port — a mail connector has no business dialling
//      6379, 8500 or 22, and the port list is where most of the internal
//      attack surface actually lives;
//   2. the HOST must resolve to a public address, checked with getaddrinfo —
//      the same resolver the socket itself will use;
//   3. the FAILURE the caller sees is a category, never the server's bytes,
//      and connect-level failures all collapse into one sentence so that
//      "refused" and "timed out" are not distinguishable from outside.
//
// 🔴 RESIDUAL, AND DELIBERATELY NOT OVERCLAIMED. Validating a name and then
// letting imapflow/nodemailer resolve it again is a TOCTOU: a DNS record with
// a one-second TTL can answer publicly for our check and privately for the
// socket (classic rebinding). Closing that needs the connection pinned to the
// address we validated, which lives in src/lib/mail/*, not here. What this
// block does buy, stated exactly: the stored host was public at least once,
// and what a rebound connection can REPORT is down from the remote end's own
// bytes to one of three fixed sentences — auth / TLS / could-not-connect. That
// is not nothing left over: three categories plus response timing is still a
// (very coarse) signal, and it is the floor this design accepts rather than a
// clean close. The poller re-dials the stored host every five minutes and
// applies no check of its own; that half is tracked, not fixed here.

// 993 = IMAP over TLS, 143 = STARTTLS. Nothing else is IMAP.
const IMAP_PORTS = new Set([143, 993])
// 465 = implicit TLS, 587 = submission/STARTTLS, 2525 = the widely-offered
// alternate for networks that block 587. 25 is deliberately NOT here: it is
// relay, not submission, every provider this connector targets refuses AUTH on
// it, and it is the single most useful port to a caller probing an internal
// network. An operator whose host really is submission-on-25 gets told which
// ports are accepted rather than silently failing.
const SMTP_PORTS = new Set([465, 587, 2525])

// Names that cannot belong to a public mail server. DNS would usually settle
// these anyway (`localhost` resolves to 127.0.0.1), but a split-horizon
// resolver need not, and refusing by name costs no round trip.
const RESERVED_SUFFIXES = [
  '.local', '.localhost', '.internal', '.intranet', '.private', '.corp', '.lan',
  '.home', '.home.arpa', '.arpa', '.onion', '.test', '.example', '.invalid', '.alt',
]

const HOSTNAME_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const PRIVATE_HOST_REFUSAL =
  'That server address is not one this connector will dial. A mailbox connection has to point at ' +
  'a mail server on the public internet — private, loopback, link-local and internal addresses are ' +
  'refused, whether typed directly or reached through a hostname.'

/**
 * Is this IPv4 address off-limits?
 *
 * Everything that is not ordinary public unicast, because the interesting
 * targets are all reserved ranges: 169.254.169.254 is the metadata endpoint on
 * every major cloud, 100.64/10 is where Tailscale lives, and 0.0.0.0/8 and
 * 127/8 both reach the function's own host. Unparseable is treated as blocked —
 * the cost of refusing an address we cannot classify is a saved form, and the
 * cost of allowing one is the whole point of this file.
 */
function ipv4Blocked(addr) {
  const parts = String(addr).split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = parts
  if (a === 0) return true                                 // 0.0.0.0/8 "this network"
  if (a === 10) return true                                // RFC 1918
  if (a === 127) return true                               // loopback
  if (a === 169 && b === 254) return true                  // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true         // RFC 1918
  if (a === 192 && b === 168) return true                  // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true        // CGNAT / Tailscale
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true   // IETF protocol + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true        // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true      // benchmarking
  if (a === 198 && b === 51 && c === 100) return true       // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true        // TEST-NET-3
  if (a >= 224) return true                                 // multicast, reserved, broadcast
  return false
}

/**
 * An IPv6 literal as eight 16-bit words, or null if it will not parse.
 * `::` expansion and a trailing dotted-quad (`::ffff:127.0.0.1`) both have to
 * be handled here — the dotted form is how a loopback address gets past a
 * check that only compares prefixes.
 */
function ipv6Words(addr) {
  const text = String(addr).split('%')[0].toLowerCase()
  const dbl = text.indexOf('::')
  const toWords = (part) => {
    if (part === '') return []
    const out = []
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        const octets = piece.split('.').map(Number)
        if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      out.push(parseInt(piece, 16))
    }
    return out
  }
  const head = toWords(dbl === -1 ? text : text.slice(0, dbl))
  const tail = toWords(dbl === -1 ? '' : text.slice(dbl + 2))
  if (!head || !tail) return null
  if (dbl === -1) return head.length === 8 ? head : null
  const gap = 8 - head.length - tail.length
  if (gap < 0) return null
  return [...head, ...new Array(gap).fill(0), ...tail]
}

/**
 * Is this IPv6 address off-limits?
 *
 * The three embedding forms are judged as the IPv4 address they carry rather
 * than by prefix: `::ffff:169.254.169.254`, `64:ff9b::169.254.169.254` and
 * `2002:a9fe:a9fe::` are all the metadata endpoint, and a prefix-only check
 * misses every one of them.
 */
function ipv6Blocked(addr) {
  const w = ipv6Words(addr)
  if (!w) return true
  const asV4 = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  if (w.every(x => x === 0)) return true                       // ::
  if (w.slice(0, 7).every(x => x === 0) && w[7] === 1) return true  // ::1 loopback
  if (w.slice(0, 5).every(x => x === 0) && w[5] === 0xffff) return ipv4Blocked(asV4(w[6], w[7]))
  if (w.slice(0, 6).every(x => x === 0)) return ipv4Blocked(asV4(w[6], w[7]))  // ::a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b) return ipv4Blocked(asV4(w[6], w[7]))   // NAT64
  if (w[0] === 0x2002) return ipv4Blocked(asV4(w[1], w[2]))                    // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return true                  // fc00::/7 unique-local
  if ((w[0] & 0xffc0) === 0xfe80) return true                  // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true                  // fec0::/10 site-local
  if ((w[0] & 0xff00) === 0xff00) return true                  // ff00::/8 multicast
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true    // 100::/64 discard
  return false
}

const addressBlocked = (addr) => (isIP(addr) === 6 ? ipv6Blocked(addr) : ipv4Blocked(addr))

/**
 * May this route dial `host`?
 *
 * A literal address is judged directly. A name is shape-checked, refused on a
 * reserved suffix, then resolved with getaddrinfo — `dns.lookup`, not
 * `dns.resolve`, deliberately: it is the same path `net.connect` takes, so it
 * honours /etc/hosts and the resolver order the socket will honour. EVERY
 * answer has to be public: a name with one public A record and one private one
 * is refused outright rather than hoping the socket picks the public one.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function assertDialableHost(host, label) {
  const name = String(host || '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!name) return { ok: false, error: `Enter the ${label} server address.` }

  if (isIP(name)) {
    return addressBlocked(name) ? { ok: false, error: PRIVATE_HOST_REFUSAL } : { ok: true }
  }

  // At least one dot is required by the shape, which also disposes of bare
  // `localhost` and of every single-label internal name.
  if (name.length > 255 || !HOSTNAME_SHAPE.test(name)) {
    return {
      ok: false,
      error: `“${host}” is not a server name. Enter the ${label} server exactly as the mail provider gives it, for example imap.example.com.`,
    }
  }
  if (RESERVED_SUFFIXES.some(suffix => name.endsWith(suffix))) {
    return { ok: false, error: PRIVATE_HOST_REFUSAL }
  }

  let addresses
  try {
    addresses = await dnsLookup(name, { all: true })
  } catch {
    // Not an oracle worth withholding — anyone can resolve a public name from
    // anywhere — and it is the single most useful thing to tell an operator who
    // has mistyped their host.
    return {
      ok: false,
      error: `“${host}” could not be looked up. Check the ${label} server address for a typo.`,
    }
  }
  if (!addresses?.length || addresses.some(entry => addressBlocked(entry.address))) {
    return { ok: false, error: PRIVATE_HOST_REFUSAL }
  }
  return { ok: true }
}

/**
 * Turn a verify failure into something an operator can act on, WITHOUT handing
 * back what the remote server said.
 *
 * imap-connection.js and smtp-send.js redact the caller's own password and cap
 * the length, which makes the string safe to STORE — it is not the same thing
 * as safe to RETURN, because the string is the remote end's, and the remote end
 * is chosen by the caller. So the raw text is classified here and thrown away;
 * it stays in the server log, where support can read it and a tenant cannot.
 *
 * The categories are the ones that lead to different operator actions. Every
 * connect-level failure — refused, filtered, timed out, DNS gone — collapses
 * into ONE message on purpose: telling them apart is precisely the port-scan
 * oracle this exists to remove, and it is a distinction no operator acts on
 * differently anyway.
 */
function verifyFailureKind(raw) {
  const text = String(raw || '')
  if (/invalid credential|authenticationfailed|auth\w* fail|login (?:failed|denied|refused)|invalid login|username and password not accepted|application[- ]specific password|not authenticated|\b53[0-5]\b/i.test(text)) {
    return 'auth'
  }
  if (/\btls\b|\bssl\b|certificate|self[- ]signed|wrong version number|handshake|eproto|unable to verify|starttls/i.test(text)) {
    return 'tls'
  }
  return 'connect'
}

const IMAP_FAILURE_MESSAGE = {
  auth:
    'The mail server refused that username and password. For Gmail use a 16-character app password ' +
    '— the account password is always rejected — and check the sign-in name.',
  tls:
    'The secure connection to the incoming server could not be established. Check the port and the ' +
    'encryption setting: 993 is IMAP over SSL, 143 is STARTTLS.',
  connect:
    'Could not complete a login check against that incoming server. Check the server address and ' +
    'port with the mail provider.',
}

// The 465-vs-587 confusion is the single most common real misconfiguration on
// this form — pairing 587 with implicit TLS fails as an opaque connect timeout
// rather than as a TLS error — so that sentence survives the redaction, as does
// the way out: the outgoing server is optional and receive-only is a supported
// release state (mig 572's `egress` comment).
const SMTP_FAILURE_MESSAGE = {
  auth:
    'The outgoing server refused that username and password. Some providers need a separate ' +
    'submission password, or the same app password with a different sign-in name.',
  tls:
    'The secure connection to the outgoing server could not be established — check the port and the ' +
    'encryption setting (465 for SSL, 587 for STARTTLS).',
  connect:
    'Could not complete a login check against that outgoing server. Check the server address and ' +
    'port (465 for SSL, 587 for STARTTLS).',
}

const SMTP_WAY_OUT =
  ' Or leave the outgoing server blank to connect this account for receiving only.'

// A LIVE DIAL IS A PRIVILEGE, NOT A FREE ACTION. Even with the host and port
// constrained, an unthrottled verify endpoint is a scanner: a few thousand
// requests enumerate which public mail hosts exist and which of them accept a
// given username. Keyed per CALLER, like the password-override route, because
// the action is identity-bound — one owner tidying a settings form does not
// contend with another studio's. The number is the same 20-in-15-minutes the
// password-override route settled on, and it is sized against the real busiest
// case rather than the typical one: a studio with six accounts connecting them
// all in one sitting, at a save or two each — the panel's own comment says six
// is a number that happens. It is still nowhere near a scan. Fail-open inside
// checkRateLimit, so a limiter outage never blocks a real reconnect.
const VERIFY_RATE = { max: 20, windowMs: 15 * 60_000 }

/** Hostnames are case-insensitive and may carry a root dot; the account is the same one. */
const sameHost = (a, b) =>
  String(a || '').trim().replace(/\.$/, '').toLowerCase() === String(b || '').trim().replace(/\.$/, '').toLowerCase()

/**
 * GET — what the connection panel renders.
 *
 * A FAILED READ IS NOT "NOT CONNECTED". Answering `connection: null` on a
 * database blip would show a live studio the first-connect form and invite an
 * owner to re-paste a credential that is working perfectly — a wrong answer
 * dressed as a normal one. It 500s instead and the panel keeps its last render.
 */
export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox

  const { data: credential, error: credErr } = await db.from('email_mailbox_credentials')
    .select(CONNECTION_STATE_COLUMNS)
    .eq('mailbox_id', params.mailboxId)
    .maybeSingle()
  if (credErr) {
    logError(MODULE, 'credential state read failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: credErr.message,
    })
    return bad('Could not read this account’s connection.', 500)
  }

  const { data: folders, error: ingressErr } = await db.from('email_mailbox_ingress')
    .select(INGRESS_COLUMNS)
    .eq('mailbox_id', params.mailboxId)
    .limit(FOLDER_LIMIT)
  if (ingressErr) {
    // Best-effort, unlike the credential read above: health is a diagnostic
    // panel, and losing it must never cost the operator the ability to see or
    // change the connection itself. `null` renders as "no poll history yet"
    // rather than as a confident green.
    logWarn(MODULE, 'ingress health read failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: ingressErr.message,
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      connection: connectionView(credential),
      ingress: mailbox.ingress,
      egress: mailbox.egress,
      folders: ingressErr ? null : (folders || []),
      // The mailbox address, so the form can offer it as the username without
      // the client having to hold the account list to render this panel.
      address: mailbox.address,
      // MAILBOX-OAUTH.6 — which provider sign-ins exist and, for the ones that
      // do not work, WHY. Served rather than hard-coded in the component for
      // one reason: Google's refusal is a paragraph about app verification and
      // a CASA assessment, and the day that changes it must change in ONE
      // place. A second copy in JSX is how a screen ends up telling an operator
      // something the API stopped believing months ago.
      //
      // Carries no client id and no secret and does not vary per tenant — it
      // is a table of product facts, safe for any session that reached this
      // route's gate.
      oauth_providers: oauthProviderCatalogue(),
    },
  })
}

/**
 * PUT — connect the account, or change its settings / password.
 *
 * Order is deliberate and each step exists because skipping it fails silently:
 *   1. mailbox must be live at THIS location (loadMailboxOr404 → 404)
 *   2. mailbox must be active — see the refusal below
 *   3. provider must be one we can actually authenticate
 *   4. encryption must be configured — never store a password we cannot seal
 *   5. the host and port must be ones this route may dial at all (the SSRF
 *      block above) — checked before any socket is opened, and before the
 *      caller's dial budget is spent on a target we were never going to reach
 *   6. resolve the credential (fresh password, or carry the stored one)
 *   7. spend one dial from the caller's budget
 *   8. PROVE it against the live IMAP server, and against SMTP if one is named
 *   9. only then write: credential, then flip ingress, then CLEAR THE FAILURE
 *      STATE so the poller actually resumes — a verified login that leaves
 *      `paused_until` a day out is a save that changed nothing an operator can
 *      see for a day
 */
export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const validation = await validateBody(request, ConnectionBody)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox

  // A DEACTIVATED ACCOUNT MUST NOT BE CONNECTED. Deactivation stops inbound
  // routing — resolveMailboxByRecipient skips inactive mailboxes and returns
  // null rather than guessing — so the poller would happily read the real
  // mailbox, hand each message to the inbound route, and the route would find
  // nothing to file it against. Mail would be pulled out of the customer's
  // inbox and land nowhere, which is the one failure this subsystem's history
  // is entirely about.
  if (!mailbox.active) {
    return bad(
      'This account is deactivated, so mail sent to it does not route anywhere. Reactivate it first, then connect the mailbox.',
      400
    )
  }

  if (body.provider === 'microsoft') return bad(MICROSOFT_REFUSAL, 400)

  // ── PHASE 11.1 — HOW MANY ACCOUNTS ONE LOCATION MAY CONNECT ───────────────
  //
  // Connected mailboxes are not free to anyone but the tenant who connects
  // them. Each one is an IMAP session, a body download per message and an
  // attachment upload per file, every five minutes, out of ONE shared cron with
  // ONE wall-clock budget. imap-poll.js already stops that becoming a
  // cross-tenant outage — fair ordering by last_run_at, a concurrency cap and a
  // deadline re-checked between mailboxes — but every one of those degrades the
  // sweep GRACEFULLY, which is another way of saying a runaway tenant makes
  // everyone else's mail slower and nothing ever says so.
  //
  // 🔴 THE CAP IS ON CONNECTING, NOT ON EXISTING. A mailbox row is nearly free:
  // MAILBOX_LIMIT is a .limit() sized against the 1,000-row select cap, not a
  // tenancy rule, and a Postmark-MX mailbox costs the poller nothing at all. It
  // is the LOGIN that costs, so that is what is counted.
  //
  // 🔴 AND ONLY WHEN THIS ONE IS NOT ALREADY CONNECTED. PUT is also how a
  // password is rotated and how a host is corrected. Counting the mailbox in
  // front of us would mean a studio sitting exactly on the cap could no longer
  // fix a revoked app password — the cap would turn a routine repair into a
  // disconnect-and-reconnect dance, and the disconnect drops the poll cursor.
  // A limit that blocks maintenance is worse than no limit.
  const alreadyConnected = mailbox.ingress === 'imap'
  if (!alreadyConnected) {
    const { count, error: countErr } = await db.from('email_mailboxes')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', params.id)
      .eq('ingress', 'imap')
    if (countErr) {
      // Fail OPEN, loudly. Refusing on an unreadable count would block a
      // legitimate connection over a transient database fault, and the ceiling
      // this protects is a fairness nicety — not a safety property worth
      // trading a working mailbox for. The estate's rule: log structurally,
      // accept the rarer wrong outcome, fail closed only when proceeding is
      // actively harmful.
      logError(MODULE, 'could not count connected mailboxes — allowing the connect', {
        locationId: params.id, mailboxId: params.mailboxId, error: countErr.message,
      })
    } else if ((count ?? 0) >= MAX_CONNECTED_MAILBOXES_PER_LOCATION) {
      return bad(
        `This studio already has ${count} connected mailboxes, which is the limit. ` +
        'Disconnect one you no longer read before connecting another, or ask for the limit to be raised.',
        400,
        { code: 'connected_mailbox_limit' }
      )
    }
  }

  // NEVER fall back to storing plaintext. secret-box throws on a missing or
  // malformed key by design; checking first turns that into a sentence an
  // operator can escalate rather than a 500 with a stack trace, and it is
  // checked BEFORE the live login so we do not make the operator wait on a
  // network round trip for a deployment fault.
  if (!isConfigured()) {
    logError(MODULE, 'MAILBOX_SECRET_KEY is not configured', { locationId: params.id })
    return bad(
      'Mailbox passwords cannot be stored on this deployment yet — its encryption key is not configured. Nothing has been saved.',
      503
    )
  }

  // ── WHAT THIS ROUTE IS ALLOWED TO DIAL ───────────────────────────────────
  // Before the credential is even resolved, because none of it matters if the
  // target is one we will not open a socket to, and because a refusal here must
  // cost the caller nothing on the network — no connect, no DNS-timing signal
  // from a port we were never going to use.
  //
  // BOTH LEGS ARE CHECKED TOGETHER. Checking IMAP, dialling it, and only then
  // looking at the SMTP host would let a caller pair a real mail server with an
  // internal one and learn something from which leg failed.
  const smtpHost = orNull(body.smtp_host)
  const imapHost = body.imap_host.trim()

  if (!IMAP_PORTS.has(body.imap_port)) {
    return bad(
      `Incoming (IMAP) port ${body.imap_port} is not a mail port. Use 993 for IMAP over SSL, or 143 for STARTTLS.`,
      400,
      { code: 'imap_port_refused' }
    )
  }
  // `?? 465` mirrors what smtp-send.js itself does with a null port, so the
  // port that is checked is the port that would actually be dialled.
  const smtpPort = body.smtp_port ?? 465
  if (smtpHost && !SMTP_PORTS.has(smtpPort)) {
    return bad(
      `Outgoing (SMTP) port ${smtpPort} is not a mail submission port. Use 465 for SSL or 587 for STARTTLS ` +
      '(some providers also offer 2525), or leave the outgoing server blank to connect this account for receiving only.',
      400,
      { code: 'smtp_port_refused' }
    )
  }

  const imapTarget = await assertDialableHost(imapHost, 'incoming (IMAP)')
  if (!imapTarget.ok) return bad(imapTarget.error, 400, { code: 'imap_host_refused' })
  if (smtpHost) {
    const smtpTarget = await assertDialableHost(smtpHost, 'outgoing (SMTP)')
    if (!smtpTarget.ok) return bad(smtpTarget.error, 400, { code: 'smtp_host_refused' })
  }

  // 🔴 THE ONE READ IN THIS FILE THAT NAMES THE SECRET, and it is a WRITE-path
  // read: it exists so "change the host, keep the password" works. The value
  // is handed to resolveAuth and to nothing else — it never reaches the
  // response, the audit row, a log line or an error string.
  const { data: existing, error: existingErr } = await db.from('email_mailbox_credentials')
    .select(`${CONNECTION_STATE_COLUMNS}, secret_ciphertext`)
    .eq('mailbox_id', params.mailboxId)
    .maybeSingle()
  if (existingErr) {
    logError(MODULE, 'existing credential read failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: existingErr.message,
    })
    return bad('Could not read this account’s current connection.', 500)
  }

  // MAILBOX-OAUTH.6 — see OAUTH_ALREADY_CONNECTED_REFUSAL. Checked here rather
  // than at the top because it needs the stored row, and placed BEFORE the
  // credential merge so no dial is spent on a save that will not be written.
  if (existing && String(existing.auth_type || '').toLowerCase() === 'oauth') {
    return bad(OAUTH_ALREADY_CONNECTED_REFUSAL, 400, { code: 'oauth_connected' })
  }

  const username = body.username.trim()
  const freshPassword = isFreshSecret(body.password) ? String(body.password).trim() : null

  // Write-only secret merge, spelled out rather than routed through
  // mergeSecretSlice: the stored value here is CIPHERTEXT and the incoming one
  // is PLAINTEXT, so they are not interchangeable slots on one object — the
  // fresh value has to be sealed before it can stand in for the stored one.
  let auth
  let nextCiphertext = null
  if (freshPassword) {
    auth = { user: username, pass: freshPassword }
    nextCiphertext = seal(freshPassword)
  } else if (existing?.secret_ciphertext) {
    // resolveAuth reads `username` off the row, so the row it is handed
    // carries the NEW username — otherwise "the login changed but the password
    // did not" would be verified against the old account.
    const verdict = resolveAuth({ ...existing, username })
    if (!verdict.ok) {
      // auth-strategy never returns the secret in an error; these strings are
      // written to be shown to a person ('decrypt_failed' is the one that
      // needs a human rather than a retry).
      return bad(`The stored password could not be used: ${verdict.error}`, 400, { code: verdict.reason })
    }
    auth = verdict.auth
  } else {
    return bad(
      'Enter the mailbox password (an app password, for Gmail) — there is nothing stored for this account yet.',
      400
    )
  }

  // ── ONE DIAL, CHARGED ────────────────────────────────────────────────────
  // Spent here rather than at the top of the handler so that a refused target,
  // a missing password or a deactivated mailbox — none of which opens a socket
  // — does not eat an operator's budget for the save they are about to get
  // right.
  const dialBudget = await checkRateLimit(db, `mailbox-connect:${user.id}`, VERIFY_RATE)
  if (!dialBudget.allowed) {
    // Said in the operator's terms rather than as a bare "too many requests" —
    // the limit is on LIVE LOGINS to somebody else's mail server, which is a
    // thing a person can understand waiting for.
    return rateLimitResponse(
      dialBudget,
      'Too many connection checks in a row. Each save tries a real login against the mail server, so ' +
      'they are limited — wait a few minutes and try again. Nothing has been changed.'
    )
  }

  // ── VERIFY, THEN PERSIST. Never the other way round. ──────────────────────
  // verifyConnection never throws, and it redacts the caller's own password
  // out of its error — but the rest of that string is the REMOTE end's, and the
  // remote end was chosen by whoever filled in this form. It is logged, never
  // returned; the caller gets a category (see verifyFailureKind).
  const verify = await verifyConnection(
    { host: imapHost, port: body.imap_port, secure: body.imap_secure, auth },
    'INBOX'
  )
  if (!verify.ok) {
    const kind = verifyFailureKind(verify.error)
    logWarn(MODULE, 'imap verify failed', {
      locationId: params.id, mailboxId: params.mailboxId,
      host: imapHost, port: body.imap_port, kind, error: verify.error,
    })
    return bad(IMAP_FAILURE_MESSAGE[kind], 400, { code: 'imap_verify_failed' })
  }

  // BOTH LEGS ARE PROVEN, not just the one that matters today. Sending over
  // SMTP is Phase 7's switch to throw, so an unverified smtp_host stored here
  // would sit quietly until that flip and then fail in front of a member. It
  // is checked now, while the operator is still looking at the form.
  //
  // The refusal names the way out: the outgoing server is OPTIONAL, and
  // receive-over-IMAP-while-replying-through-Postmark is a supported release
  // state (mig 572's `egress` comment), not a broken half-configuration. So
  // "clear this field and you are still connected for receiving" is a real
  // answer, which is why refusing here does not cost the operator the feature.
  //
  // The single most common misconfiguration this catches: 465 is implicit TLS
  // (secure true) and 587 is STARTTLS (secure FALSE). Pairing 587 with true
  // fails as an opaque connect timeout rather than as a TLS error, which is
  // exactly the sort of thing nobody diagnoses from a settings screen.
  if (smtpHost) {
    const smtpVerify = await verifySmtpConnection({
      host: smtpHost, port: body.smtp_port ?? undefined, secure: body.smtp_secure, auth,
    })
    if (!smtpVerify.ok) {
      // Same redaction as the IMAP leg — nodemailer's EAUTH errors quote the
      // server's response verbatim, which is exactly the half we must not
      // forward — but the 465/587 sentence and the way out both survive it.
      const kind = verifyFailureKind(smtpVerify.error)
      logWarn(MODULE, 'smtp verify failed', {
        locationId: params.id, mailboxId: params.mailboxId,
        host: smtpHost, port: smtpPort, kind, error: smtpVerify.error,
      })
      return bad(SMTP_FAILURE_MESSAGE[kind] + SMTP_WAY_OUT, 400, { code: 'smtp_verify_failed' })
    }
  }

  const nowIso = new Date().toISOString()
  const settings = {
    provider: body.provider,
    auth_type: 'password',
    username,
    imap_host: imapHost,
    imap_port: body.imap_port,
    imap_secure: body.imap_secure,
    smtp_host: smtpHost,
    smtp_port: body.smtp_port ?? null,
    smtp_secure: body.smtp_secure,
    sent_folder: orNull(body.sent_folder),
    updated_at: nowIso,
  }

  // 🔴 COMPUTED BEFORE THE WRITE, and it has to be: `existing` is the row as it
  // was, and the update below overwrites exactly the two columns this compares.
  // Asking the question afterwards would answer "nothing changed" every time —
  // which is the same as not asking it, and the cursor would never be dropped.
  // What it means, and why it is identity rather than "any save", is in the
  // resume block further down.
  const identityChanged =
    !existing ||
    !sameHost(existing.imap_host, settings.imap_host) ||
    (existing.username || '') !== username

  // CREDENTIAL FIRST, THEN THE ingress FLIP. The two orderings fail
  // differently and only one of them is safe: with the flip first, a failed
  // credential write leaves the poller told to read a mailbox it has no login
  // for, and every tick records an auth failure against a mailbox nobody
  // connected. This way the worst case is a stored, verified credential that
  // is not being polled yet — visible, harmless, and fixed by pressing Save
  // again.
  if (existing) {
    const patch = { ...settings }
    // Only a fresh password rewrites the ciphertext. Assigning
    // `secret_ciphertext: null` on a settings-only save would wipe the working
    // credential, which is the exact shape of the Glofox null-collapse.
    if (nextCiphertext) patch.secret_ciphertext = nextCiphertext
    const { error } = await db.from('email_mailbox_credentials')
      .update(patch)
      .eq('mailbox_id', params.mailboxId)
    if (error) {
      logError(MODULE, 'credential update failed', {
        locationId: params.id, mailboxId: params.mailboxId, code: error.code, error: error.message,
      })
      return bad('Could not save the connection.', 500)
    }
  } else {
    const { error } = await db.from('email_mailbox_credentials')
      .insert({
        mailbox_id: params.mailboxId,
        ...settings,
        secret_ciphertext: nextCiphertext,
        created_by: user.id,
        created_at: nowIso,
      })
    if (error) {
      logError(MODULE, 'credential insert failed', {
        locationId: params.id, mailboxId: params.mailboxId, code: error.code, error: error.message,
      })
      return bad('Could not save the connection.', 500)
    }
  }

  // ── AUDIT THE MOMENT THE CREDENTIAL IS ON DISK, NOT AT THE END ───────────
  //
  // This used to sit after the flip and the poll-resume write, which meant a
  // DB blip on EITHER of those returned 500 with the credential already
  // persisted and NOTHING in audit_events saying it had changed. The two 500s
  // below both say so in their own copy — "the login was saved and verified" —
  // so the handler already knew it was reporting a failure over a completed
  // write. An audit log that records only the fully-successful path is not an
  // audit log for exactly the cases anyone opens it for.
  //
  // Everything in `details` is knowable here: `settings`, `freshPassword` and
  // `identityChanged` are all computed above, and `verified: true` is the
  // reason we got this far at all. Nothing downstream can change any of it —
  // the flip and the cursor clear are consequences of this write, not inputs
  // to it. Ordering the audit after them bought nothing and risked the record.
  //
  // The three actions stay distinct so `email_mailbox_connection.credential_changed`
  // is greppable in /admin/audit-log — a rotated app password is the event you
  // go looking for when a mailbox stops receiving.
  const action = !existing
    ? 'email_mailbox_connection.connected'
    : (freshPassword ? 'email_mailbox_connection.credential_changed' : 'email_mailbox_connection.updated')

  await logAuditEvent({
    category: 'mutation',
    action,
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    // No target.id — it maps to audit_events.target_profile_id (FK → profiles)
    // and a mailbox is not a profile. Identity rides in `resource`.
    target: { label: `${mailbox.label} <${mailbox.address}>`, resource: `email_mailbox/${mailbox.id}` },
    locationId: params.id,
    // NOTHING SECRET IN HERE. `password_changed` is a boolean about the event,
    // never a hint at the value; audit_events is read by more people and kept
    // for longer than any other table this feature touches.
    details: {
      address: mailbox.address,
      provider: settings.provider,
      username: settings.username,
      imap_host: settings.imap_host,
      imap_port: settings.imap_port,
      imap_secure: settings.imap_secure,
      smtp_host: settings.smtp_host,
      smtp_port: settings.smtp_port,
      sent_folder: settings.sent_folder,
      password_changed: !!freshPassword,
      verified: true,
      // Worth a forensic record: a cursor reset means everything already in
      // that mailbox is below the new watermark and will never be ingested.
      cursor_reset: identityChanged,
    },
    request,
  })

  // BOTH DIRECTIONS ARE SET HERE, and `egress` FOLLOWS THE SMTP FIELD rather
  // than getting a toggle of its own.
  //
  // This was deliberately left alone while the SMTP transport did not exist —
  // flipping a mailbox to SMTP then would have broken every reply from it.
  // MAILBOX-CONNECT.7 shipped the transport and wired the three send call
  // sites, so the flip is now safe and the column has to be reachable: a value
  // nothing ever writes is a feature that cannot be switched on.
  //
  // Why no separate "send as this address" checkbox: the outgoing server field
  // already IS the opt-in. It is optional, it was just proven to authenticate
  // above, and an operator who supplies working SMTP credentials for an address
  // is asking for replies to leave from it. A second control would let the two
  // disagree — verified SMTP credentials sitting next to a switch that says
  // don't use them — which is a state nobody can read off the screen.
  //
  // Clearing the field is therefore the way back to Postmark, and it takes
  // effect on the same save. Receive-over-IMAP-while-replying-through-Postmark
  // stays fully supported (spec §8's R1); it is simply the no-SMTP case.
  const { error: flipErr } = await db.from('email_mailboxes')
    .update({
      ingress: 'imap',
      egress: smtpHost ? 'smtp' : 'postmark',
      updated_at: nowIso,
    })
    .eq('id', params.mailboxId)
    .eq('location_id', params.id)
  if (flipErr) {
    // Loud, not silent, and NOT a claim that nothing happened: the credential
    // IS stored and IS verified. Saying "could not save" here would send the
    // operator round the loop again with a password they already banked.
    logError(MODULE, 'ingress flip failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: flipErr.message,
    })
    return bad(
      'The login was saved and verified, but this account is not receiving over it yet. Press Save once more.',
      500,
      { code: 'ingress_flip_failed' }
    )
  }

  // ── A VERIFIED SAVE MUST ACTUALLY RESUME POLLING ─────────────────────────
  // MAILBOX-CONNECT.8. `email_mailboxes` is not the only thing standing between
  // a stored credential and a polled mailbox: imap-poll.js returns early —
  // `{ ok: true, reason: 'paused' }` — for as long as `paused_until` is in the
  // future, and the AUTH backoff curve parks that up to 24 HOURS out. So the
  // headline failure this closes is the ordinary one: an app password is
  // revoked, the mailbox fails its way into a day-long pause, the operator
  // generates a new password and saves it, this route proves it against the
  // live server, stores it, answers `verified: true` — and no mail arrives for
  // another day, while the panel renders "Paused" and the revoked-password
  // error right next to "Connected. The login was checked…". Disconnect →
  // Connect cleared it, because DELETE drops the ingress rows; the flow every
  // operator actually reaches for did not.
  //
  // `consecutive_failures` goes with it: leaving the counter at 6 would put the
  // next single blip straight back at the top of the curve.
  //
  // Clearing `last_error` is not cosmetic either. It is what the settings card
  // renders as the reason, and a stale reason beside a fresh success is the
  // exact contradiction that makes an operator distrust the panel. If the
  // account is still broken the very next tick writes the error back.
  //
  // ── AND THE CURSOR, BUT ONLY WHEN THE ACCOUNT CHANGED ────────────────────
  // `uidvalidity`/`last_uid` are a watermark INTO ONE ACCOUNT. Repointing a
  // mailbox at a different login — a different `username`, or the same name on
  // a different `imap_host` — while keeping the old watermark means every
  // message at or below it is skipped, silently: usually the UIDVALIDITY
  // mismatch re-anchors and saves us, but the two servers only have to collide
  // on that one number for the mail to be gone with nothing recorded. DELETE
  // already drops the cursor for exactly this reason; the "change the login"
  // path has to as well.
  //
  // NOT on every save, though. Dropping the cursor cold-starts the folder, and
  // a cold start anchors to the current highest UID and ingests NOTHING (spec
  // §3.5), so a needless reset silently skips whatever arrived since the last
  // tick. Hence: identity, not settings. A first connect counts as an identity
  // change too — a cursor left behind by a disconnect whose best-effort delete
  // failed is precisely the stale watermark this guards against.
  //
  // The host comparison is case-insensitive (DNS is), the username comparison
  // is not: a host that really does distinguish `Studio@` from `studio@` is
  // rare, but the cost of resetting a cursor we did not need to is a few
  // minutes of unpolled mail, and the cost of keeping one we should have
  // dropped is silent, permanent loss.
  const resume = {
    consecutive_failures: 0,
    paused_until: null,
    last_error: null,
    updated_at: nowIso,
  }
  if (identityChanged) {
    resume.uidvalidity = null
    resume.last_uid = null
  }

  // Every folder for this mailbox, not just 'inbox' — Phase 8's Sent cursor is
  // the same account and inherits the same pause and the same watermark
  // problem. A mailbox with no ingress row yet matches nothing, which is the
  // correct no-op rather than an error.
  const { error: resumeErr } = await db.from('email_mailbox_ingress')
    .update(resume)
    .eq('mailbox_id', params.mailboxId)
  if (resumeErr) {
    // Loud and NOT a claim that nothing happened — same shape as the flip
    // above. The credential is stored and verified; what has not happened is
    // the un-pausing, and answering "connected" here would recreate the very
    // day of silence this block exists to prevent.
    logError(MODULE, 'poll resume failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: resumeErr.message,
    })
    return bad(
      'The login was saved and verified, but checking has not been restarted for this account yet. Press Save once more.',
      500,
      { code: 'poll_resume_failed' }
    )
  }

  // The audit event for this save was written the moment the credential landed
  // on disk — see the block above the ingress flip for why it is not here.

  return NextResponse.json({
    success: true,
    data: {
      // Built from `settings`, NOT from `{ ...existing, ...settings }`. The
      // spread would have been harmless — connectionView picks named fields —
      // but `existing` is the one object in this handler carrying the
      // ciphertext, and an object holding a secret should never be handed to a
      // function whose whole job is producing a response body. Only
      // `created_at` is genuinely wanted from it, so only that is taken.
      connection: connectionView({ ...settings, created_at: existing?.created_at ?? nowIso }),
      ingress: 'imap',
      // MAILBOX-CONNECT.7 — the value just written, not `mailbox.egress`, which
      // is the row as it was READ at the top of the handler and is now stale.
      // The card renders "replies leave as this address" off this field, so
      // returning the pre-write value would show the operator the opposite of
      // what they just saved until they reloaded.
      egress: smtpHost ? 'smtp' : 'postmark',
      verified: true,
    },
  })
}

/**
 * DELETE — disconnect.
 *
 * Idempotent: disconnecting an account that was never connected is a success,
 * not a 404, and writes no audit row claiming something changed.
 *
 * ORDER: destroy the credential FIRST, then put the mailbox back on Postmark.
 * The reverse ordering leaves a live app password in the database after the
 * operator has been told it is gone, which is the failure with a security
 * consequence; this ordering's worst case is a mailbox still flagged `imap`
 * with no login, which the poller records as a visible error every tick until
 * someone presses Disconnect again.
 */
export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const found = await loadMailboxOr404(db, params.id, params.mailboxId)
  if (found.response) return found.response
  const mailbox = found.mailbox
  // Snapshot the prior transports BY VALUE, the way the sibling PATCH route
  // snapshots label/is_default/active. The audit row's whole worth here is
  // "this account used to receive over IMAP"; reading mailbox.ingress again
  // after the reset below would record 'postmark' as the previous state and
  // the row would say nothing at all.
  const before = { ingress: mailbox.ingress, egress: mailbox.egress }

  // State columns only — the secret is not needed to delete the row, and a
  // query that does not name it cannot leak it.
  const { data: existing, error: existingErr } = await db.from('email_mailbox_credentials')
    .select(CONNECTION_STATE_COLUMNS)
    .eq('mailbox_id', params.mailboxId)
    .maybeSingle()
  if (existingErr) {
    logError(MODULE, 'credential read before disconnect failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: existingErr.message,
    })
    return bad('Could not read this account’s connection.', 500)
  }

  if (!existing && before.ingress === 'postmark' && before.egress === 'postmark') {
    return NextResponse.json({ success: true, data: { changed: false, connection: null, ingress: 'postmark', egress: 'postmark' } })
  }

  const { error: delErr } = await db.from('email_mailbox_credentials')
    .delete()
    .eq('mailbox_id', params.mailboxId)
  if (delErr) {
    // A failed delete must never answer "Disconnected" — the operator would
    // walk away believing the password is gone while the poller keeps using it.
    logError(MODULE, 'credential delete failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: delErr.message,
    })
    return bad('Could not disconnect this account.', 500)
  }

  // The cursor goes with it. A watermark belongs to the ACCOUNT it was read
  // from, and reconnecting a different login behind the same mailbox with a
  // stale last_uid would skip everything below it — silent mail loss. Dropping
  // it costs nothing: a fresh connection cold-starts, and a cold start ingests
  // nothing by design (spec §3.5), so there is no re-ingest to fear either.
  const { error: cursorErr } = await db.from('email_mailbox_ingress')
    .delete()
    .eq('mailbox_id', params.mailboxId)
  if (cursorErr) {
    // Logged, never fatal. The credential is already gone, so a leftover
    // cursor row cannot pull mail; refusing here would tell the operator the
    // disconnect did not happen when it did.
    logWarn(MODULE, 'ingress cursor delete failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: cursorErr.message,
    })
  }

  // Both columns, not just ingress. If egress were ever left on 'smtp' with no
  // credential behind it, every reply from this account would fail to send —
  // and it would fail at send time, in front of a member, not here.
  const { error: resetErr } = await db.from('email_mailboxes')
    .update({ ingress: 'postmark', egress: 'postmark', updated_at: new Date().toISOString() })
    .eq('id', params.mailboxId)
    .eq('location_id', params.id)
  if (resetErr) {
    logError(MODULE, 'transport reset failed', {
      locationId: params.id, mailboxId: params.mailboxId, error: resetErr.message,
    })
    return bad(
      'The login was deleted, but this account has not been switched back to the standard mail route. Press Disconnect once more.',
      500,
      { code: 'transport_reset_failed' }
    )
  }

  await logAuditEvent({
    category: 'mutation',
    action: 'email_mailbox_connection.disconnected',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { label: `${mailbox.label} <${mailbox.address}>`, resource: `email_mailbox/${mailbox.id}` },
    locationId: params.id,
    // The disconnect DELETES the row, so audit_events is the only place that
    // will remember this account was ever connected, to what, and by whom.
    details: {
      address: mailbox.address,
      was: existing
        ? {
            provider: existing.provider,
            username: existing.username,
            imap_host: existing.imap_host,
            smtp_host: existing.smtp_host ?? null,
          }
        : null,
      previous_ingress: before.ingress,
      previous_egress: before.egress,
    },
    request,
  })

  return NextResponse.json({
    success: true,
    data: { changed: true, connection: null, ingress: 'postmark', egress: 'postmark' },
  })
}
