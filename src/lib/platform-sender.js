// W1.E2 — the PLATFORM sender, read from the environment and never spelled.
//
// Before an organisation verifies its own sending domain (tenant_email_domains
// status 'live'), every tenant email goes out from the platform address with
// the tenant's BRAND as the display name and the location's own address as
// Reply-To. The platform address is whatever POSTMARK_FROM_EMAIL holds
// (today hello@un1t.ie; hello@repset.ie once the Postmark domain is verified,
// Richard's prerequisite P2). No module in this repo spells an address: the
// env is the single source, and it is parsed here so a value written as
// "Name <addr>" and one written as a bare address both yield the ADDRESS, the
// display name always being the brand's (or PLATFORM_NAME's), never the env's.
//
// Pure except for the env read and one structured log line when the env is
// unset (a config fault that must be loud: a send with no From is refused by
// Postmark with its own message, which is the "no silent env fallback" rule).

import { PLATFORM_NAME } from './brand-name.js'
import { logError } from './log.js'

/**
 * Split an RFC 5322-ish mailbox into its parts. `"Name" <addr>` and
 * `Name <addr>` give { name, address }; a bare address gives name ''.
 * Never throws; an empty input gives both parts empty.
 * @param {string|null|undefined} value
 * @returns {{ name: string, address: string }}
 */
export function parseAddressHeader(value) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return { name: '', address: '' }
  const m = s.match(/^(.*?)\s*<([^<>]+)>\s*$/)
  if (!m) return { name: '', address: s }
  const rawName = m[1].trim()
  const name = /^".*"$/.test(rawName) ? rawName.slice(1, -1).trim() : rawName
  return { name, address: m[2].trim() }
}

// A display name that would read as address syntax (`<`, `>`, a comma, a
// quote…) is quoted, so a brand such as "Gym A, Dublin" is one mailbox on the
// wire rather than two; quotes and backslashes inside it are dropped rather
// than escaped. Line breaks can never reach a header. Non-ASCII names
// ("Café Gym") are left as-is: Postmark RFC-2047-encodes display names itself.
function safeName(name) {
  const n = (typeof name === 'string' ? name : '').replace(/[\r\n]+/g, ' ').trim()
  if (!n) return ''
  return /[",<>@;:\\()[\]]/.test(n) ? `"${n.replace(/["\\]/g, '')}"` : n
}

/**
 * `Name <address>`, or the bare address when the name is empty, or null when
 * there is no address at all (a header with no address is no header).
 * @param {string|null|undefined} name
 * @param {string|null|undefined} address
 * @returns {string|null}
 */
export function formatAddressHeader(name, address) {
  const a = (typeof address === 'string' ? address : '').trim()
  if (!a) return null
  const n = safeName(name)
  return n ? `${n} <${a}>` : a
}

/**
 * The platform's bare sending ADDRESS, from POSTMARK_FROM_EMAIL (either form
 * accepted — see the header). Read fresh each call so it reflects the live
 * config. Null when the env is unset.
 * @returns {string|null}
 */
export function platformFromAddress() {
  return parseAddressHeader(process.env.POSTMARK_FROM_EMAIL).address || null
}

/**
 * The platform From header: `${displayName || PLATFORM_NAME} <platform address>`.
 * The display name is the caller's (a tenant brand, an operator's From name);
 * the env's own display name, if it carries one, is never used. With the env
 * unset this logs and returns null — the caller sends no From and Postmark
 * refuses loudly, which beats inventing an address.
 * @param {string|null|undefined} [displayName]
 * @returns {string|null}
 */
export function platformFromHeader(displayName) {
  const address = platformFromAddress()
  if (!address) {
    logError('platform-sender', 'POSTMARK_FROM_EMAIL is not set — no platform From address for this send')
    return null
  }
  return formatAddressHeader((displayName || '').trim() || PLATFORM_NAME, address)
}

/**
 * The From that goes on the wire for one message. Pure.
 *
 *   resolvedFrom set (a resolved sender: the platform pre-domain, the org's
 *   verified From after) → ITS address, always; the display name is, in order,
 *   the explicit `fromName`, the display name inside an explicit `from`
 *   header, then the resolved sender's own name. This is the plan's
 *   displayNameOverride: a campaign's "Garrett at Gym A" stays, its address
 *   never does.
 *   no resolvedFrom, `from` given → `from` as the caller wrote it (byte-identical
 *   for every caller that passes a full header), with `fromName` replacing its
 *   display name when both are given.
 *   neither → the platform header with `fromName` (or PLATFORM_NAME).
 *
 * @param {{ from?: string|null, fromName?: string|null, resolvedFrom?: string|null }} opts
 * @returns {string|null|undefined}
 */
export function wireFrom({ from, fromName, resolvedFrom } = {}) {
  const explicit = parseAddressHeader(from)
  const name = (typeof fromName === 'string' ? fromName.trim() : '') || explicit.name
  if (resolvedFrom) {
    const r = parseAddressHeader(resolvedFrom)
    return formatAddressHeader(name || r.name, r.address) || resolvedFrom
  }
  if (explicit.address) {
    const explicitName = typeof fromName === 'string' ? fromName.trim() : ''
    return explicitName ? formatAddressHeader(explicitName, explicit.address) : from
  }
  return platformFromHeader(name)
}

/**
 * A resolved sender ({ fromEmail, fromName } from resolveEmailSender) as a
 * header, or null when it carries no address. Pure.
 * @param {{ fromEmail?: string|null, fromName?: string|null }|null|undefined} sender
 * @returns {string|null}
 */
export function resolvedFromOf(sender) {
  if (!sender?.fromEmail) return null
  return formatAddressHeader(sender.fromName, sender.fromEmail)
}
