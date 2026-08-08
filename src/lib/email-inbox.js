// EMAIL-INBOX.1 — pure helpers for the email channel of the unified
// inbox: inbound Postmark payload parsing, threading resolution and
// reply composition.
//
// Threading model (mirrors the IG pair, migs 231/394):
//   • ONE conversation per (location_id, counterpart_email) — same
//     shape as instagram_conversations' (location_id, ig_user_id).
//     RFC threading headers are used to RESOLVE contact + location
//     for the first message from an address, not to split threads:
//     a gym lead emailing about two topics is still one relationship
//     for the queue/resolve/assign workflow.
//   • In-Reply-To / References are matched against
//     email_sends.postmark_message_id. Postmark's outbound RFC
//     Message-ID embeds its API MessageID as the local part
//     (<uuid@mtasv.net>), so we emit both the full id and the
//     local part as candidates. If Postmark ever changes that,
//     matching degrades gracefully to From-address resolution.
//
// Everything here is pure (no DB, no env) so the webhook's threading
// logic is unit-testable; the route owns the queries.

/** Cap stored HtmlBody — inbound HTML can be megabytes of quoted chains. */
export const HTML_BODY_MAX_CHARS = 300_000

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// EMAIL-INBOUND-POISON.1 — bytes Postgres text cannot hold. `[^@\s]` admits
// NUL, other control characters and lone surrogates, and an "address" carrying
// one fails the INSERT of every column it lands in — deterministically, on
// every Postmark retry. No real mail server delivers such an address, so it is
// REJECTED rather than stripped: stripping would merge `a\u0000b@x.com` into
// the real `ab@x.com`, linking a stranger's mail to a real contact (the same
// identity-forgery class as the LIKE-wildcard bug in like-escape.js).
// The `u` flag makes the surrogate range match LONE halves only — a valid
// pair (an astral character) is one code point outside the range.
const UNSTORABLE_RE = /[\u0000-\u001f]|[\ud800-\udfff]/u

/** Lowercased, trimmed address — or null if it doesn't look like one. */
export function normalizeEmail(addr) {
  if (!addr || typeof addr !== 'string') return null
  const e = addr.trim().toLowerCase()
  if (UNSTORABLE_RE.test(e)) return null
  return EMAIL_RE.test(e) ? e : null
}

/** Case-insensitive lookup in Postmark's Headers array ([{ Name, Value }]). */
export function getHeader(headers, name) {
  if (!Array.isArray(headers)) return null
  const lower = String(name).toLowerCase()
  const hit = headers.find(h => typeof h?.Name === 'string' && h.Name.toLowerCase() === lower)
  return hit?.Value ?? null
}

/** Pull every <...> token out of a header value, brackets stripped. */
function parseMessageIdTokens(value) {
  if (!value || typeof value !== 'string') return []
  const tokens = value.match(/<[^<>]+>/g)
  if (tokens) return tokens.map(t => t.slice(1, -1).trim()).filter(Boolean)
  const bare = value.trim()
  return bare ? [bare] : []
}

/**
 * Candidate ids to match against email_sends.postmark_message_id, most
 * specific first: In-Reply-To, then References newest→oldest. Each RFC
 * id also contributes its local part (before '@') because Postmark's
 * outbound Message-ID is `<postmark-uuid>@mtasv.net` while email_sends
 * stores the bare uuid.
 */
export function extractCandidateMessageIds(headers) {
  const raw = [
    ...parseMessageIdTokens(getHeader(headers, 'In-Reply-To')),
    ...parseMessageIdTokens(getHeader(headers, 'References')).reverse(),
  ]
  const out = []
  const seen = new Set()
  for (const id of raw) {
    for (const candidate of [id, id.includes('@') ? id.slice(0, id.indexOf('@')) : null]) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate)
        out.push(candidate)
      }
    }
  }
  return out
}

/** The inbound email's own RFC Message-ID (brackets stripped) — stored so replies can thread. */
export function extractRfcMessageId(headers) {
  const value = getHeader(headers, 'Message-ID')
  const tokens = parseMessageIdTokens(value)
  return tokens[0] || null
}

/** Addresses from a "Name <addr>, addr" display string. */
function parseAddressList(str) {
  if (!str || typeof str !== 'string') return []
  return str.split(',').map(part => {
    const angled = part.match(/<([^<>]+)>/)
    return normalizeEmail(angled ? angled[1] : part)
  }).filter(Boolean)
}

/**
 * The sender's address off a Postmark inbound payload, or null.
 *
 * FromFull.Email (typed, already bare) is preferred; the raw `From` header is
 * the fallback — and it is a DISPLAY string ("Ada Member <member@x.com>"), so
 * it goes through the same angle-bracket extraction as every other display
 * header here. The bare-address parse used to run on it directly, fail on the
 * display form, and drop the mail as `no_sender` with the address in plain
 * sight.
 */
export function senderEmail(payload) {
  if (!payload || typeof payload !== 'object') return null
  return normalizeEmail(payload.FromFull?.Email) || parseAddressList(payload.From)[0] || null
}

/**
 * An email Date header as an ISO timestamp, or null when it does not parse.
 *
 * `new Date(value).toISOString()` throws a RangeError on a malformed date, and
 * the header is attacker-supplied — inlined in the webhook, that throw was a
 * deterministic 5xx on every Postmark retry of the same payload
 * (EMAIL-INBOUND-POISON.1). Callers fall back to their own receive time.
 */
export function parseEmailDate(value) {
  if (!value || typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Every address this email was delivered to, normalized + deduped:
 * ToFull/CcFull (typed), the To display string, and OriginalRecipient
 * (the SMTP envelope ground truth when the visible To was rewritten —
 * same fallback chain as the invoices-inbound webhook).
 */
export function recipientEmails(payload) {
  if (!payload || typeof payload !== 'object') return []
  const out = []
  const seen = new Set()
  const push = (e) => {
    const n = normalizeEmail(e)
    if (n && !seen.has(n)) { seen.add(n); out.push(n) }
  }
  for (const r of Array.isArray(payload.ToFull) ? payload.ToFull : []) push(r?.Email)
  for (const r of Array.isArray(payload.CcFull) ? payload.CcFull : []) push(r?.Email)
  for (const e of parseAddressList(payload.To)) push(e)
  push(payload.OriginalRecipient)
  return out
}

/**
 * Match the delivered-to addresses against per-location
 * locations.email_inbox_reply_to (the Postmark inbound address each
 * studio advertises as Reply-To). JS-side compare: single-digit row
 * count, avoids a case-mangling SQL dance.
 */
export function matchLocationByRecipient(locations, recipients) {
  if (!Array.isArray(locations) || !Array.isArray(recipients)) return null
  const wanted = new Set(recipients.map(r => String(r).toLowerCase()))
  return locations.find(l => {
    const addr = normalizeEmail(l?.email_inbox_reply_to)
    return addr && wanted.has(addr)
  }) || null
}

/**
 * Deterministic pick when several contacts share the From address:
 * contacts at the resolved location beat other locations; then oldest
 * created_at (the original record, not a later import dupe); then
 * lowest id as a total-order tiebreak.
 */
export function pickContact(contacts, preferredLocationId) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null
  const atLocation = preferredLocationId
    ? contacts.filter(c => c.location_id === preferredLocationId)
    : []
  const pool = atLocation.length ? atLocation : contacts
  return [...pool].sort((a, b) => {
    const at = new Date(a.created_at || 0).getTime()
    const bt = new Date(b.created_at || 0).getTime()
    if (at !== bt) return at - bt
    return String(a.id).localeCompare(String(b.id))
  })[0]
}

/** "Re: ..." exactly once; a stand-in for empty subjects. */
export function replySubject(subject) {
  const s = (subject || '').trim()
  if (!s) return 'Re: (no subject)'
  return /^re:/i.test(s) ? s : `Re: ${s}`
}

/**
 * RFC 5322 threading headers for a reply: In-Reply-To = the inbound
 * message's Message-ID; References = the inbound References chain
 * plus that id. Returns [] when the inbound carried no Message-ID
 * (the reply still sends, it just starts a fresh thread client-side).
 */
export function buildReplyHeaders({ rfcMessageId, referencesHeader }) {
  if (!rfcMessageId) return []
  const bracketed = rfcMessageId.startsWith('<') ? rfcMessageId : `<${rfcMessageId}>`
  const refs = (referencesHeader || '').trim()
  return [
    { Name: 'In-Reply-To', Value: bracketed },
    { Name: 'References', Value: refs ? `${refs} ${bracketed}` : bracketed },
  ]
}

/** Queue-row preview: whitespace collapsed, 100 chars (matches WA/IG). */
export function inboundPreview(text) {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 100)
}

/** Cap the stored HtmlBody (see HTML_BODY_MAX_CHARS). */
export function truncateHtmlBody(html) {
  if (html == null) return null
  const s = String(html)
  return s.length > HTML_BODY_MAX_CHARS ? s.slice(0, HTML_BODY_MAX_CHARS) : s
}
