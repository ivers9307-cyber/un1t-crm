// IMAP-CONN.3.3 — an IMAP message → a Postmark-inbound-shaped payload.
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §3
//
// ⚠️ PURE. No IO, no network, no clock, no env, no DB. Everything this module
// needs arrives on `msg` or in the options object. That is not a stylistic
// preference — it is what makes the heart of the feature unit-testable, and
// this file is the heart of the feature. (`node:crypto`'s createHash is a pure
// function of its input, which is why syntheticMessageId may use it and still
// be deterministic under test with no fixtures, no clock and no environment.)
//
// WHY THIS FILE EXISTS AT ALL
// The ticketing inbox has exactly one ingress: the Postmark inbound webhook at
// /api/webhooks/postmark-inbound/[token]. That route's `processInboundEmail`
// is ~500 lines and is the single most safety-critical function in the estate:
// dedupe claim/release, crash-window classification, finishDedupedDelivery,
// poison-text defusing, eight dead-letter doors. The whole silent-mail-loss
// history is written into it. So the poller does NOT reimplement any of that —
// it is a PRODUCER, the second instance of the `postmark-inbound-shim` pattern:
// reshape a payload, POST it at the existing route, inherit the pipeline
// byte-for-byte. This module is that reshaping, and nothing else.
//
// THE TWO LOAD-BEARING FIELDS
//   • OriginalRecipient — set to the connected mailbox's own address.
//     recipientEmails() (src/lib/email-inbox.js) collects it LAST in its
//     precedence order and resolveMailboxByRecipient() (src/lib/email-mailboxes.js)
//     matches it against active mailboxes. That, and only that, is why an IMAP
//     message files itself into the right studio's queue with ZERO changes to
//     the webhook route.
//     ⚠️ Precedence is ToFull → CcFull → To → OriginalRecipient. A message
//     addressed *To* a DIFFERENT mailbox of ours but delivered to this one
//     resolves to the other one. That is the documented behaviour (§3.1), not
//     a bug in this mapper — we emit the truth of the headers and let the
//     existing precedence decide.
//   • Headers — an array of { Name, Value }, because that is the shape
//     getHeader() reads. The route pulls Message-ID, In-Reply-To and
//     References out of it and that is how a reply threads onto an existing
//     ticket (extractCandidateMessageIds → email_sends.postmark_message_id).
//     Drop those and every reply opens a brand new ticket.
//
// EXACTLY WHICH `body.*` FIELDS THE ROUTE READS (audited against
// src/app/api/webhooks/postmark-inbound/[token]/route.js, 2026-08-26):
//   body.MessageID    → required; 400 if falsy. THREE jobs, which is why its
//                       format is constrained (see SYNTHETIC_ID_RE): the
//                       dedupe key (`inbound-email:<MessageID>`); the value
//                       written to email_inbox_messages.postmark_message_id,
//                       whose unique partial index is the completion marker;
//                       and the Storage path segment for staged attachments,
//                       `inbound/<postmark_message_id>/<n>.<ext>`.
//   body.FromFull.Email / body.From  → senderEmail(); no sender ⇒ dead-letter
//   body.FromFull.Name               → email_tickets.requester_name
//   body.ToFull / body.To            → recipientEmails() + inboundAddresses()
//   body.CcFull / body.Cc            → recipientEmails() + inboundAddresses()
//   body.OriginalRecipient           → recipientEmails() (last resort)
//   body.Subject                     → ticket + message subject
//   body.TextBody / body.HtmlBody    → message bodies (HTML falls back to
//                                      htmlToPlainText for the text column)
//   body.Date                        → parseEmailDate(); falls back to now()
//   body.Headers                     → Message-ID / In-Reply-To / References
//   body.Attachments                 → storeInboundAttachments / discard
// Nothing else on the payload is read. We emit exactly that set (minus `Cc`,
// which is fully covered by CcFull — see buildPayload).
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   • It does not sanitise body text. The route already runs sanitizeDbText()
//     over Subject, FromFull.Name, TextBody, HtmlBody and the threading
//     headers (EMAIL-INBOUND-POISON.1), and doing it twice would only mean two
//     places to keep in step. The ONE exception is the RFC Message-ID, which
//     is sanitised here — see safeRfcMessageId() for why that one is different.
//   • It does not decode MIME encoded-words. imapflow has already decoded
//     `envelope.subject` and the address display names via lib/charsets.js, so
//     a second decode could only corrupt a subject that legitimately contains
//     the literal text "=?".
//   • It does not download anything. Bodies and attachments are handed in.

import { createHash } from 'node:crypto'
import { sanitizeDbText } from '../db-safe-text'

/**
 * How the poller must hand bodies to this mapper.
 *
 * The mapper is pure, so it cannot download a body part — Phase 5 walks the
 * bodyStructure, downloads the selected text/html parts and hangs the decoded
 * strings on the message object before calling in. Two spellings are accepted
 * because both are natural to write and a body that silently arrives empty
 * would file a member's email as a blank ticket — precisely the silent failure
 * this codebase refuses. `text`/`html` is the mailparser/imapflow idiom and is
 * the preferred one; `textBody`/`htmlBody` mirrors the Postmark naming.
 */
const TEXT_KEYS = ['text', 'textBody']
const HTML_KEYS = ['html', 'htmlBody']

/**
 * Longest RFC Message-ID we will carry.
 *
 * Since IMAP-CONN.3.3b the synthetic id is a fixed-width digest, so this no
 * longer protects an index row — the value it bounds is the one written to
 * `email_inbox_messages.rfc_message_id` (via the Headers array) and re-read on
 * every render of the ticket. Message-IDs are attacker-suppliable and a
 * multi-kilobyte one would ride along forever for no benefit. Truncating risks
 * a collision only between two ids sharing a 400-character prefix, which no
 * real mail system produces.
 */
const MAX_RFC_MESSAGE_ID_CHARS = 400

/**
 * 🔴 THE SYNTHETIC MessageID MUST MATCH /^[A-Za-z0-9_-]{1,64}$/. DO NOT
 * "improve" it back into a readable `imap:<uuid>:<rfc-id>` form.
 *
 * That readable form was the originally pinned contract and it is BROKEN. The
 * value this function returns is handed to the webhook route as `body.MessageID`
 * and the route passes it straight on as `postmarkMessageId`
 * (route.js — storeInboundAttachments / discardStagedAttachments), where it
 * becomes a Storage OBJECT PATH SEGMENT: `inbound/<postmark_message_id>/<n>.<ext>`.
 * `stagedAttachmentPath()` / `stagedPathMatches()` in
 * src/lib/email-attachment-staging.js:81 validate that segment against
 * PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/ — deliberately stricter than a uuid,
 * because nothing about an inbound payload is ours. The colons, the `@` and the
 * dots in an RFC Message-ID all fail it, and so does the length. Every IMAP
 * attachment would have read back as `{ kind: 'skip', reason: 'rehost_failed' }`
 * while its bytes sat orphaned in a metered bucket. Found by the Phase 4 agent
 * before either half shipped.
 *
 * The replacement keeps every property the readable form had:
 *   • deterministic  — pure function of (mailboxId, rfcMessageId), so a re-poll
 *     produces the same id and the unique index on
 *     `email_inbox_messages.postmark_message_id` still completes the delivery
 *   • unique         — 160 bits of SHA-256 over BOTH ids in full
 *   • non-colliding with a real Postmark MessageID — those are lowercase-hex
 *     uuids, and `i`/`m`/`p` are not hex digits, so the `imap-` prefix makes a
 *     collision structurally impossible rather than merely unlikely
 *   • debuggable     — the mailbox's own uuid prefix stays in the clear and is
 *     greppable, and the human-readable Message-ID is not lost: the route
 *     stores it separately in `email_inbox_messages.rfc_message_id`, so a row
 *     always carries both halves of the mapping
 */
const SYNTHETIC_ID_PREFIX = 'imap-'
const MAILBOX_PREFIX_CHARS = 8
const DIGEST_CHARS = 40
/** The contract this file must satisfy — mirrors PATH_SEGMENT in email-attachment-staging.js. */
export const SYNTHETIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Header names carried through to the route, in this order. */
const MESSAGE_ID_HEADER = 'Message-ID'
const IN_REPLY_TO_HEADER = 'In-Reply-To'
const REFERENCES_HEADER = 'References'

/**
 * A display name needs quoting when it contains an RFC 5322 "special".
 *
 * The route parses the `To` display string with `display.split(',')`
 * (inboundAddresses, src/lib/email-recipients.js), so an unquoted
 * `Smith, John <j@x.com>` would split mid-name. The address itself survives
 * that (the fragment after the comma still normalises), but emitting a
 * malformed header when a correct one costs three lines is not a trade worth
 * taking.
 */
const NEEDS_QUOTING = /[",;:<>@\\[\]()]/

/**
 * Control characters, DEL and whitespace — none of which may appear inside a
 * Message-ID. Written with \u escapes on purpose: literal control bytes in a
 * source file make it unreadable to grep (it reports the whole file as binary).
 *
 * Lone surrogates are handled separately, by sanitizeDbText(), which walks code
 * points and so can tell an orphan half from a valid astral pair. A regex
 * character class cannot.
 */
const ID_UNSAFE = /[\u0000-\u001f\u007f\s]/g

/* ────────────────────────── small pure helpers ───────────────────────── */

/** The first entry of `keys` on `obj` that is a non-empty string, else null. */
function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** `<abc@x.com>` → `abc@x.com`. Idempotent; tolerates whitespace and junk. */
function stripBrackets(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const angled = trimmed.match(/<([^<>]+)>/)
  const bare = (angled ? angled[1] : trimmed).trim()
  return bare || null
}

/**
 * An RFC Message-ID that is safe to use as a database key.
 *
 * Unlike the body text, this one IS sanitised here rather than left to the
 * route — because the route does NOT sanitise it. `body.MessageID` goes
 * straight into `dedupeEventId()` and into the `postmark_message_id` column
 * with no sanitizeDbText in between (verified against the route). A NUL or a
 * lone surrogate in a Message-ID would therefore fail the INSERT
 * deterministically on every retry, which is the EMAIL-INBOUND-POISON.1
 * failure mode all over again — except here nothing retries it away, because
 * the poller's watermark sits behind the poison message forever.
 *
 * Control characters are dropped rather than the whole id rejected: a
 * Message-ID is an opaque identifier, not an address, so there is no identity
 * to forge by stripping (contrast normalizeEmail, which REJECTS rather than
 * strips for exactly that reason).
 */
function safeRfcMessageId(value) {
  const bare = stripBrackets(value)
  if (!bare) return null
  const cleaned = sanitizeDbText(bare).replace(ID_UNSAFE, '').trim()
  if (!cleaned) return null
  return cleaned.slice(0, MAX_RFC_MESSAGE_ID_CHARS)
}

/**
 * Parse a raw header block into [{ Name, Value }].
 *
 * imapflow returns `msg.headers` as a Buffer of the header lines it was asked
 * for (FetchMessageObject.headers), NOT as a parsed object — so this is where
 * the References header actually becomes readable. Buffers, strings and
 * already-parsed arrays are all accepted so a caller (or a test) can hand in
 * whichever it has.
 *
 * Folding is unfolded per RFC 5322 §2.2.3: a line beginning with SP or HTAB
 * continues the previous one. References headers are routinely folded across
 * five or six lines, and a mapper that ignored folding would silently drop
 * every parent id but the first — i.e. it would thread the shallowest replies
 * and quietly fail the deep ones.
 */
function parseHeaderBlock(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter(h => h && typeof h.Name === 'string')
      .map(h => ({ Name: h.Name, Value: typeof h.Value === 'string' ? h.Value : String(h.Value ?? '') }))
  }
  let text = null
  if (typeof raw === 'string') text = raw
  else if (raw && typeof raw.toString === 'function' && (Buffer.isBuffer?.(raw) || raw instanceof Uint8Array)) {
    text = Buffer.from(raw).toString('utf8')
  }
  if (!text) return []

  const out = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    if (/^[ \t]/.test(line)) {
      // Continuation of the previous header. The CRLF goes away and the
      // leading whitespace collapses to a single space (RFC 5322 unfolding).
      if (current) current.Value = `${current.Value} ${line.trim()}`.trim()
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    current = { Name: line.slice(0, colon).trim(), Value: line.slice(colon + 1).trim() }
    out.push(current)
  }
  return out
}

/** Case-insensitive lookup over a parsed header list. Mirrors getHeader(). */
function headerValue(headers, name) {
  const lower = name.toLowerCase()
  const hit = headers.find(h => h.Name.toLowerCase() === lower)
  const value = hit?.Value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * One address entry → { Email, Name }.
 *
 * imapflow's envelope gives `{ name, address }` objects, already MIME-decoded.
 * A raw display string ("Ada <a@b.com>") is accepted too: some servers, and
 * every hand-written fixture, produce that form, and quietly returning null
 * for it would drop the sender of a real email.
 */
function toAddressEntry(entry) {
  if (!entry) return null
  if (typeof entry === 'string') {
    const trimmed = entry.trim()
    if (!trimmed) return null
    const angled = trimmed.match(/^(.*)<([^<>]+)>\s*$/)
    if (angled) {
      const name = angled[1].trim().replace(/^"(.*)"$/, '$1').trim()
      const email = angled[2].trim()
      return email ? { Email: email, Name: name || null } : null
    }
    return { Email: trimmed, Name: null }
  }
  if (typeof entry !== 'object') return null
  const email = typeof entry.address === 'string' ? entry.address.trim() : ''
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (!email) {
    // No address, but the "name" may itself be a display string — the shape a
    // few servers return for a malformed From. Recurse on it rather than
    // dropping a message whose sender is sitting in plain sight (the same
    // lesson senderEmail() learned in src/lib/email-inbox.js).
    return name ? toAddressEntry(name) : null
  }
  return { Email: email, Name: name || null }
}

/** An imapflow envelope address array → [{ Email, Name }], junk dropped. */
function toAddressList(list) {
  if (!Array.isArray(list)) return []
  return list.map(toAddressEntry).filter(Boolean)
}

/** [{ Email, Name }] → the RFC display string a `To:`/`From:` header carries. */
function formatAddressList(entries) {
  return entries
    .map(({ Email, Name }) => {
      if (!Name) return Email
      const name = NEEDS_QUOTING.test(Name) ? `"${Name.replace(/([\\"])/g, '\\$1')}"` : Name
      return `${name} <${Email}>`
    })
    .join(', ')
}

/**
 * A date off the message as an ISO string, or null.
 *
 * The route calls parseEmailDate(body.Date), which takes a STRING and returns
 * null on anything unparseable — so a Date instance handed over verbatim would
 * be silently discarded and every message would carry the poller's own receive
 * time. Emit ISO text.
 */
function toIsoDate(value) {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  const t = d.getTime()
  return Number.isNaN(t) ? null : d.toISOString()
}

/* ──────────────────────────── the public API ─────────────────────────── */

/**
 * The MessageID the payload carries:
 * `imap-<8 hex of mailboxId>-<40 hex of sha256(mailboxId:rfcMessageId)>`.
 *
 * ⚠️ The FORMAT is constrained — see SYNTHETIC_ID_RE above before changing a
 * character of it. It is a Storage path segment as well as a database key.
 *
 * WHY NAMESPACED (§3.2). This value becomes both the dedupe key
 * (`inbound-email:<MessageID>`) and `email_inbox_messages.postmark_message_id`,
 * whose unique partial index is what marks an inbound delivery complete. The
 * `imap-` prefix guarantees it can never collide with a real Postmark id (a
 * lowercase-hex uuid), so a Postmark delivery webhook can never correlate
 * against an IMAP row — and folding `mailboxId` into the digest keeps two
 * connected mailboxes that were both copied on the same email as two separate
 * tickets, which is what an operator expects when accounts@ and sales@ are
 * both on a thread.
 *
 * Stable across re-polls because both inputs are stable and the function is
 * pure, which is the whole of the dedupe story: no new machinery, no migration
 * (§3.2).
 *
 * @param {string} mailboxId  email_mailboxes.id
 * @param {string} rfcMessageId  the message's own RFC Message-ID, brackets
 *   already stripped
 * @returns {string|null} null when either half is missing — the caller must
 *   treat that as "cannot be deduped", never invent one.
 */
export function syntheticMessageId(mailboxId, rfcMessageId) {
  const id = typeof mailboxId === 'string' ? mailboxId.trim() : ''
  const rfc = typeof rfcMessageId === 'string' ? rfcMessageId.trim() : ''
  if (!id || !rfc) return null

  // The mailbox's own uuid, in the clear, so the id stays greppable against
  // email_mailboxes.id. Hyphens and any non-hex character are dropped and the
  // result is padded, so this is well-formed for a value that is not a uuid
  // too — uniqueness never rests on it, the digest below covers both ids in
  // full.
  const prefix = id.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, MAILBOX_PREFIX_CHARS)
    .padEnd(MAILBOX_PREFIX_CHARS, '0')

  // A hash is a pure function of its input — no IO, no clock, no env — so this
  // does not break the module's purity guarantee. The separator makes the
  // preimage unambiguous: without it, (mailbox 'ab', id 'c') and
  // (mailbox 'a', id 'bc') would digest identically.
  const digest = createHash('sha256').update(`${id}:${rfc}`, 'utf8').digest('hex')

  return `${SYNTHETIC_ID_PREFIX}${prefix}-${digest.slice(0, DIGEST_CHARS)}`
}

/**
 * An IMAP message → the Postmark-inbound-shaped payload the existing webhook
 * route accepts. Pure; never throws.
 *
 * @param {object} msg  a message as returned by fetchSince(), with the decoded
 *   bodies attached by the poller:
 *     { uid, envelope, bodyStructure, headers, internalDate,
 *       text|textBody, html|htmlBody }
 * @param {object} opts
 * @param {string} opts.mailboxAddress  the connected mailbox's own address —
 *   becomes OriginalRecipient, which is what routes the mail
 * @param {string} opts.mailboxId  email_mailboxes.id — namespaces the MessageID
 * @param {Array} [opts.attachments]  Postmark-shaped Attachments entries, as
 *   produced by Phase 4's stageImapAttachments(). Passed through untouched.
 * @returns {object} the payload. `MessageID` is null when the message has
 *   neither an RFC Message-ID nor a usable UID — the route answers 400 for
 *   that and the poller isolates it per-message (5.1), which is the honest
 *   outcome: without a stable id there is nothing to dedupe on.
 */
export function toInboundPayload(msg, { mailboxAddress, mailboxId, attachments = [] } = {}) {
  const source = msg && typeof msg === 'object' ? msg : {}
  const envelope = source.envelope && typeof source.envelope === 'object' ? source.envelope : {}
  const headers = parseHeaderBlock(source.headers)

  // ── Threading ────────────────────────────────────────────────────
  // The explicitly-fetched header wins over the envelope for Message-ID and
  // In-Reply-To (it is the raw truth of the message); References exists ONLY
  // as a fetched header, because imapflow's ENVELOPE does not carry it — which
  // is the entire reason fetchSince() asks for headers at all.
  const rfcMessageId = safeRfcMessageId(
    headerValue(headers, MESSAGE_ID_HEADER) ?? envelope.messageId
  )
  const inReplyTo = headerValue(headers, IN_REPLY_TO_HEADER)
    ?? (typeof envelope.inReplyTo === 'string' ? envelope.inReplyTo.trim() || null : null)
  const references = headerValue(headers, REFERENCES_HEADER)

  // Emit a header ONLY when there is a real value behind it. An empty
  // In-Reply-To would be written to email_inbox_messages.in_reply_to as '' —
  // and an empty string is a claim ("this replies to something") where NULL is
  // the truth ("it does not"). Likewise a fabricated Message-ID would be worse
  // than none: rfc_message_id is what a future reply's In-Reply-To has to
  // match, and matching against an id no mail client has ever seen is a
  // threading failure dressed up as a success.
  const outHeaders = []
  if (rfcMessageId) outHeaders.push({ Name: MESSAGE_ID_HEADER, Value: `<${rfcMessageId}>` })
  if (inReplyTo) outHeaders.push({ Name: IN_REPLY_TO_HEADER, Value: inReplyTo })
  if (references) outHeaders.push({ Name: REFERENCES_HEADER, Value: references })

  // ── The dedupe key ───────────────────────────────────────────────
  // A real RFC Message-ID is the normal case and the only one that survives a
  // UIDVALIDITY change. When a message genuinely has none (scripts and some
  // ticketing systems omit it), fall back to a surrogate built from the UID
  // *and* the message's own date. UID alone is not enough: UIDVALIDITY
  // re-anchoring (§3.3) starts a fresh UID space from 1, so a new message
  // could take a UID an already-ingested message once held, dedupe against it
  // and be dropped — silent mail loss, the one outcome this design spends all
  // its effort avoiding. Both halves come off the message, so the surrogate is
  // as stable across re-polls as a real Message-ID.
  const uid = Number.isFinite(source.uid) && source.uid > 0 ? Math.trunc(source.uid) : null
  const envelopeDate = toIsoDate(envelope.date)
  const internalDate = toIsoDate(source.internalDate)
  const dedupeSeed = rfcMessageId
    ?? (uid ? `no-message-id.uid-${uid}.${envelopeDate ?? internalDate ?? 'nodate'}` : null)

  // ── Addresses ────────────────────────────────────────────────────
  const fromEntry = toAddressList(envelope.from)[0] ?? null
  const toEntries = toAddressList(envelope.to)
  const ccEntries = toAddressList(envelope.cc)

  // ── Bodies ───────────────────────────────────────────────────────
  // TextBody defaults to '' and HtmlBody to null, matching how the route reads
  // them (`body.TextBody || ''` and `truncateHtmlBody(body.HtmlBody || null)`)
  // — it folds both absences together, so this is about the payload being
  // honest rather than about behaviour. An HTML-only message keeps TextBody ''
  // and the route derives the plain text itself via htmlToPlainText(), which
  // is exactly what it does for an HTML-only Postmark delivery.
  const textBody = firstString(source, TEXT_KEYS)
  const htmlBody = firstString(source, HTML_KEYS)

  return {
    MessageID: syntheticMessageId(mailboxId, dedupeSeed),

    From: fromEntry ? formatAddressList([fromEntry]) : '',
    FromFull: fromEntry
      ? { Email: fromEntry.Email, Name: fromEntry.Name }
      : { Email: '', Name: null },

    To: formatAddressList(toEntries),
    ToFull: toEntries,
    // No `Cc` display string: the route reads it only as a fallback for a
    // missing CcFull (inboundAddresses reads BOTH because Postmark omits one
    // or the other on malformed headers), and we always emit CcFull from the
    // parsed envelope. A second spelling of the same list could only ever
    // disagree with the first.
    CcFull: ccEntries,

    Subject: typeof envelope.subject === 'string' ? envelope.subject : '',
    TextBody: textBody ?? '',
    HtmlBody: htmlBody ?? null,

    // envelope.date is the sender's Date header. internalDate is the server's
    // own arrival time and is the better fallback than the route's `now`: a
    // poller runs up to five minutes behind, and a mailbox catching up on a
    // backlog would otherwise stamp every message with the moment it was
    // drained rather than when it arrived. Null only when the message carries
    // neither, at which point the route's `|| now` is the honest last resort.
    Date: envelopeDate ?? internalDate,

    // 🔴 THE FIELD THAT ROUTES THE MAIL. Without it nothing matches an active
    // mailbox, resolveMailboxByRecipient returns null and the route
    // dead-letters as no_matching_mailbox.
    OriginalRecipient: typeof mailboxAddress === 'string' ? mailboxAddress : '',

    Headers: outHeaders,
    Attachments: Array.isArray(attachments) ? attachments : [],
  }
}
