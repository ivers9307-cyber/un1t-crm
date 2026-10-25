// FROMDOMAIN — which ADDRESS a campaign or sequence email goes out from.
//
// Richard's decision (11 Oct): a campaign or sequence may send from ANY
// address on the org's VERIFIED sending domain; it can never use a domain the
// org has not verified. W1.E2 (#1998) had made campaigns.from_email and
// email_sequences.from_email inert (every email from the resolver's single
// address), which took away UN1T's per-person senders (a coach's own address
// on the gym's domain). This puts them back, fenced to the verified domain.
//
//   requested address on the LIVE tenant sender's sendingDomain
//                     → the requested address, lower-cased
//   anything else     → the resolver's own fromEmail (the org's verified From,
//                       or the platform address before a verified domain)
//
// "On the domain" is exact, case-insensitive equality of the domain part:
// garrett@mail.un1tdublin.com does NOT match un1tdublin.com, and
// garrett@un1tdublin.com does NOT match mail.un1tdublin.com. A sender with no
// serverToken (the platform/global sender) never matches: the platform's
// domain is not the tenant's to borrow, and a tenant domain must only ever go
// out on the tenant's own Postmark server, where it is verified.
//
// Only the ADDRESS is decided here. The From NAME rule is W1.E2's, unchanged
// (wireFrom in platform-sender.js: the campaign/sequence from_name, else the
// resolver's name).

import { addressDomain, parseAddressHeader } from './platform-sender.js'
import { resolveEmailSender } from './tenant-email.js'

/**
 * The address a send should go out from. Pure. Never throws.
 * @param {{ requested?: string|null, sender?: { fromEmail?: string|null, serverToken?: string|null, sendingDomain?: string|null }|null }} opts
 * @returns {string|null} the requested address (lower-cased) when it is on the
 *   sender's verified domain, else the sender's own fromEmail (null when the
 *   sender carries none)
 */
export function pickFromAddress({ requested, sender } = {}) {
  const fallback = sender?.fromEmail || null
  if (!isOnVerifiedDomain({ requested, sender })) return fallback
  return parseAddressHeader(requested).address.toLowerCase()
}

/**
 * True when `requested` is a plausible address whose domain equals the LIVE
 * tenant sender's verified sendingDomain (case-insensitive, exact). Pure.
 * @param {{ requested?: string|null, sender?: object|null }} opts
 * @returns {boolean}
 */
export function isOnVerifiedDomain({ requested, sender } = {}) {
  if (!sender?.serverToken) return false
  const verified = typeof sender.sendingDomain === 'string' ? sender.sendingDomain.trim().toLowerCase() : ''
  if (!verified) return false
  const domain = addressDomain(requested)
  return !!domain && domain === verified
}

/**
 * The resolved sender with its fromEmail replaced by pickFromAddress's answer
 * — the shape sendEmail / sendBatch / sendMarketingEmail take as `sender`, so
 * the server token, display name and reply-to are the resolver's untouched.
 * A new object; the input (which may be the resolver's cached sender) is never
 * mutated. Null/undefined in → the same out.
 * @template T
 * @param {T} sender
 * @param {string|null|undefined} requested
 * @returns {T}
 */
export function withRequestedFrom(sender, requested) {
  if (!sender) return sender
  return { ...sender, fromEmail: pickFromAddress({ requested, sender }) }
}

/**
 * FROMDOMAIN — what the campaign write routes report back about a saved
 * from_email (the editor shows it): the address it will actually send as, and
 * whether the requested one is on the org's verified domain. A from_email off
 * the verified domain is still STORED (backward compatible — every UN1T
 * campaign carries one today); it is ignored at send. Never throws (the
 * resolver never does), and never carries the sender's server token.
 * @param {object} db - service-role client
 * @param {string} locationId
 * @param {string|null|undefined} requested
 * @returns {Promise<{ requested: string|null, sends_as: string|null, on_verified_domain: boolean, verified_domain: string|null }>}
 */
export async function describeFromAddress(db, locationId, requested) {
  const sender = await resolveEmailSender(db, locationId)
  const onDomain = isOnVerifiedDomain({ requested, sender })
  return {
    requested: typeof requested === 'string' && requested.trim() ? requested.trim() : null,
    sends_as: pickFromAddress({ requested, sender }),
    on_verified_domain: onDomain,
    verified_domain: sender?.serverToken && sender?.sendingDomain ? sender.sendingDomain : null,
  }
}

/**
 * The campaign write routes' `from_address` report for a request body: the
 * describeFromAddress shape when the body carried a non-empty from_email,
 * else undefined (the response then carries no `from_address` key, exactly
 * as before). Never throws.
 * @param {object} db
 * @param {string|null|undefined} locationId
 * @param {{ from_email?: string|null }|null|undefined} body
 */
export async function fromAddressReport(db, locationId, body) {
  const requested = body?.from_email
  if (typeof requested !== 'string' || !requested.trim() || !locationId) return undefined
  return describeFromAddress(db, locationId, requested)
}
