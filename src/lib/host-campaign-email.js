// Host campaign email rendering + recipient resolution (HOST-EMAIL.3).
//
// A host campaign email has exactly ONE piece of host-authored, unescaped
// input: body_html. Everything else (sender name, host name, subject, the
// unsubscribe link) is escaped, and the body itself goes through
// sanitizeCampaignHtml — a strip-list sanitizer that removes active content
// (script/style/iframe/object/embed/form/link/meta/svg/math, on* handlers,
// and every URL scheme outside http/https/mailto/tel — checked after
// entity-decoding). The footer — host name + per-host unsubscribe link
// + the "why you're receiving this" line — is injected server-side AFTER
// sanitization, so a host can never omit or strip it (spec: "enforced in the
// send path, not the composer").
//
// Recipient resolution happens AT SEND TIME (never stored): host_contacts
// membership joined to host consent (host_contacts.marketing_consent — the
// same predicate the portal Contacts page shows), minus
// host_email_suppressions, deduped by lowercased email. Pure/DB-shaped
// only — no Postmark here.

import { isEmailable } from './host-contact-list'

const PAGE = 1000 // the supabase-js 1k select cap — always .range()-paginate

// ── Sanitizer ──────────────────────────────────────────────────────

// Tags whose CONTENT is dangerous too — removed as a block.
const CONTENT_STRIP_TAGS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
// Remaining dangerous tags — the tags go, their inner content (plain text
// fallback for iframe/object/form) stays. svg/math open foreign-content
// parsing contexts (mXSS classics), so both are stripped. Also sweeps any
// stray unclosed <script>/<style> open tag left after the block pass above.
const TAG_STRIP = /<\/?(script|style|iframe|object|embed|form|link|meta|svg|math)\b[^>]*>/gi
// on* event-handler attributes: double-quoted, single-quoted, bare. The
// boundary before the attribute name may be whitespace, a `/` (SVG-style
// `<img/onerror=…>`), or a quote closing the previous attribute's value
// (`src="x"onerror=…`) — captured and put back so stripping the handler
// never eats the closing quote.
const ON_ATTR_DQ = /([\s/"'])on[a-z]+\s*=\s*"[^"]*"/gi
const ON_ATTR_SQ = /([\s/"'])on[a-z]+\s*=\s*'[^']*'/gi
const ON_ATTR_BARE = /([\s/"'])on[a-z]+\s*=\s*[^\s>'"][^\s>]*/gi
// URL-carrying attributes (href / src / xlink:href, any boundary/quoting).
// neutralizeUrlAttr scheme-checks the value against an ALLOWLIST after
// entity-decoding + control-char stripping, so entity-encoded or
// control-obfuscated schemes and any scheme outside the allowlist all
// neutralize to "#", while https/http/mailto/tel and scheme-less relative
// URLs pass through verbatim.
const URL_ATTR = /([\s/"'])((?:xlink:)?(?:href|src))\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

// Minimal entity decode for scheme sniffing: numeric (dec/hex) plus the named
// entities usable to obfuscate a scheme. Decode-for-CHECK only — a value that
// passes is kept byte-for-byte as authored.
function decodeEntitiesForCheck(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => fromCodePointSafe(parseInt(dec, 10)))
    .replace(/&(colon|tab|newline);/gi, (_, name) => ({ colon: ':', tab: '\t', newline: '\n' })[name.toLowerCase()])
}

function fromCodePointSafe(code) {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

function neutralizeUrlAttr(match, boundary, attr, rawValue) {
  let value = rawValue
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  // Browsers strip ASCII controls/whitespace anywhere in a URL before scheme
  // detection — mirror that (after entity-decoding) before sniffing.
  const decoded = decodeEntitiesForCheck(value).replace(/[\u0000-\u0020\u00a0]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)
  if (!scheme) return match // relative / fragment / '#' — inert, keep verbatim
  if (SAFE_URL_SCHEMES.has(scheme[1].toLowerCase())) return match
  return `${boundary}${attr}="#"`
}

/**
 * Strip active content from host-authored campaign HTML. Deny-list, not a
 * parser — good enough for email HTML (email clients don't run JS either;
 * this protects the operator preview surfaces and keeps abuse out of the
 * outbound mail). Applied EVERY render, on the server.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeCampaignHtml(html) {
  if (!html || typeof html !== 'string') return ''
  let out = html
  // Iterate to a fixed point: stripping one construct can splice a new one
  // together (e.g. <scr<script>ipt>). Bounded — each pass only removes.
  for (let i = 0; i < 10; i++) {
    const before = out
    out = out
      .replace(CONTENT_STRIP_TAGS, '')
      .replace(TAG_STRIP, '')
      .replace(ON_ATTR_DQ, '$1')
      .replace(ON_ATTR_SQ, '$1')
      .replace(ON_ATTR_BARE, '$1')
      .replace(URL_ATTR, neutralizeUrlAttr)
    if (out === before) break
  }
  return out
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

/**
 * Render a host campaign into the server-owned email shell: escaped sender
 * header, sanitized host body, MANDATORY footer (host name + per-host
 * unsubscribe link + consent-basis line). Email-client safe: tables + inline
 * styles only, no external CSS, no JS.
 *
 * @param {{ host: {name?:string, sender_name?:string}|null, subject: string,
 *   bodyHtml: string, unsubscribeUrl: string }} args
 * @returns {string} full HTML document
 */
export function renderHostCampaignHtml({ host, subject, bodyHtml, unsubscribeUrl }) {
  const senderName = escapeHtml(host?.sender_name || host?.name || '')
  const hostName = escapeHtml(host?.name || host?.sender_name || '')
  const safeSubject = escapeHtml(subject || '')
  const unsub = escapeHtml(unsubscribeUrl || '')

  // HOST-EMAIL.4 — a visual-composer campaign stores a FULL html document
  // (Unlayer export). Wrapping it in the shell would nest documents, so:
  // sanitize the whole thing (same strip-list — the security posture on
  // host-authored input is unchanged) and inject the mandatory footer
  // before </body> instead. The footer stays server-injected AFTER
  // sanitization so a host can never omit or strip it.
  if (/<\s*(!doctype|html)[\s>]/i.test(String(bodyHtml || '').slice(0, 500))) {
    const safeDoc = sanitizeCampaignHtml(bodyHtml)
    const footer = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td align="center" style="padding:16px 8px;font-family:${FONT};font-size:11px;line-height:1.5;color:#888888;">${hostName} &middot; <a href="${unsub}" style="color:#888888;text-decoration:underline;">Unsubscribe</a><br>You&#39;re receiving this because you attended an event or joined the mailing list.</td></tr></table>`
    if (/<\/body\s*>/i.test(safeDoc)) {
      return safeDoc.replace(/<\/body\s*>/i, `${footer}</body>`)
    }
    return safeDoc + footer
  }

  const safeBody = sanitizeCampaignHtml(bodyHtml)

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:collapse;max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:20px 32px;border-bottom:1px solid #e4e4e7;font-family:${FONT};font-size:17px;font-weight:700;color:#18181b;">${senderName}</td></tr>
<tr><td style="padding:24px 32px;font-family:${FONT};font-size:15px;line-height:1.6;color:#27272a;">${safeBody}</td></tr>
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:collapse;max-width:600px;width:100%;">
<tr><td align="center" style="padding:16px 8px;font-family:${FONT};font-size:11px;line-height:1.5;color:#888888;">
${hostName} &middot; <a href="${unsub}" style="color:#888888;text-decoration:underline;">Unsubscribe</a><br>
You&#39;re receiving this because you attended an event or joined the mailing list.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

/**
 * Resolve the recipients a host campaign would reach RIGHT NOW: the host's
 * membership rows joined to the contact's mailbox facts, gated by isEmailable
 * against HOST consent (host_contacts.marketing_consent, HOST-CONSENT.1) +
 * per-host suppression + bounce/complaint/suppressed_at — NOT the UN1T
 * broadcast predicate, deduped by lowercased email (newest membership wins —
 * memberships are ordered created_at DESC). Both queries scope
 * .eq('host_id', hostId): the caller is responsible only for resolving
 * hostId from getCurrentHost()/the campaign row.
 *
 * @param {SupabaseClient} db  service-role client
 * @param {string} hostId
 * @param {{audienceEventId?: string|null, emailType?: string, mailingListOnly?: boolean}} [options]
 * @param {boolean} [options.mailingListOnly] restrict the host_contacts query
 *   to source='mailing_list' (excludes 'event'-sourced membership rows).
 *   Every consent/suppression gate below is unaffected.
 * @returns {Promise<Array<{contact_id: string, email: string}>>}
 */
export async function resolveHostRecipients(db, hostId, { audienceEventId = null, emailType = 'marketing', mailingListOnly = false } = {}) {
  // HOST-EMAIL.4 — per-event audience. Resolved from CONFIRMED registrations
  // at send time (host_contacts.source_event_id only records the FIRST event
  // that added a contact, so it cannot answer "who attended event X").
  // Null = no restriction (every host contact).
  let allowedContactIds = null
  if (audienceEventId) {
    allowedContactIds = new Set()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('race_registrations')
        .select('id, teams:team_id ( team_members ( contact_id ) )')
        .eq('race_event_id', audienceEventId)
        .eq('status', 'confirmed')
        .order('registered_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`host campaign: attendee query failed: ${error.message}`)
      for (const reg of data || []) {
        const members = Array.isArray(reg?.teams?.team_members) ? reg.teams.team_members : []
        for (const m of members) {
          if (m?.contact_id) allowedContactIds.add(m.contact_id)
        }
      }
      if (!data || data.length < PAGE) break
    }
    if (allowedContactIds.size === 0) return []
  }

  const suppressed = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('host_email_suppressions')
      .select('contact_id')
      .eq('host_id', hostId)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host campaign: suppressions query failed: ${error.message}`)
    for (const row of data || []) suppressed.add(row.contact_id)
    if (!data || data.length < PAGE) break
  }

  const recipients = []
  const seenEmails = new Set()
  for (let from = 0; ; from += PAGE) {
    let query = db
      .from('host_contacts')
      .select(`
        contact_id, marketing_consent,
        contact:contacts!contact_id ( id, email, email_administrative, email_status, email_suppressed_at )
      `)
      .eq('host_id', hostId)
    if (mailingListOnly) query = query.eq('source', 'mailing_list')
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host campaign: contacts query failed: ${error.message}`)
    for (const row of data || []) {
      if (allowedContactIds && !allowedContactIds.has(row.contact_id)) continue
      const contact = row.contact || null
      if (!isEmailable(contact, suppressed.has(row.contact_id), { emailType, hostConsent: row.marketing_consent === true })) continue
      const key = String(contact.email).trim().toLowerCase()
      if (seenEmails.has(key)) continue
      seenEmails.add(key)
      recipients.push({ contact_id: row.contact_id, email: contact.email })
    }
    if (!data || data.length < PAGE) break
  }
  return recipients
}
