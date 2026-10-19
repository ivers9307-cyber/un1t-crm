// MIAHATCH.6 — helpers shared by Mia's two un1t.online write executors,
// un1t-booking.js (book, cancel, refund requests) and purchase-intents.js
// (payment links), so the two can never disagree on which studio settings,
// which contact, which retryable codes or which class time they act on.
// (purchase-intents.js imports un1t-booking.js for the booking steps the free
// trial shares; un1t-booking.js loads purchase-intents.js lazily for its offer
// list, so neither needs the other at load time.)
import { UN1T_WRITE_CODES as C } from '@/lib/un1t-online-write'
import { formatClassTime } from './dublin-format'

/** D's RETRYABLE set (un1t-online-write.js): nothing was sent, a later try is safe. */
export const UN1T_RETRY_CODES = Object.freeze(new Set([C.RATE_BUDGET, C.RATE_LIMITED, C.ATTEMPT_IN_FLIGHT, C.PERMISSIONS_UNREADABLE]))

/** The action studio's resolved Mia settings (booking_mode, booking_url, copy), or null. */
export async function actionSettings(ctx, studio) {
  let settings = null
  try {
    settings = typeof ctx.actionStudio === 'function' ? await ctx.actionStudio(studio.locationId) : null
  } catch {
    settings = null
  }
  if (!settings && studio.locationId === ctx.locationId) settings = ctx.settings || null
  return settings
}

/** The account's own contact runs a write (and is its card's or intent's contact): the verified one when it holds the account, else the studio's first. */
export function executingContactOf(ctx, studio) {
  const ids = Array.isArray(studio.contactIds) ? studio.contactIds.filter(Boolean) : []
  return ids.includes(ctx.verifiedContactId) ? ctx.verifiedContactId : (ids[0] || ctx.verifiedContactId)
}

// An ISO-looking relay, and one that names its offset (Z or ±hh:mm). An
// offset-less one would be read in the host's zone by Date.parse (CLAUDE.md
// forbids), so it is refused as no match.
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
const normLabel = (s) => String(s).toLowerCase().replace(/[,\s]+/g, ' ').trim()

/** A class start (epoch ms) as the formatClassTime label in the studio's zone. Pure. */
export const classTimeLabel = (ms, zone) => formatClassTime(Math.floor(ms / 1000), zone)

/**
 * Does the class time the model relayed name this class? Both sides are
 * compared as formatClassTime labels in the studio's own zone: the relayed
 * label as given (case, spaces and commas aside), or an ISO instant WITH an
 * offset (Z or ±hh:mm) rendered in that zone; an offset-less ISO is no match. A label for another studio's class, or one rendered with the
 * wrong offset across a DST change, does not match. Missing is no match. Pure.
 *
 * @param {string} eventStartsAtIso the class's starts_at (mirror)
 * @param {string|null|undefined} relayed the starts_at the model passed
 * @param {string} zone the studio's IANA zone
 */
export function relayedStartMatches(eventStartsAtIso, relayed, zone) {
  const eventMs = Date.parse(eventStartsAtIso || '')
  if (!Number.isFinite(eventMs) || typeof relayed !== 'string' || !relayed.trim()) return false
  const want = classTimeLabel(eventMs, zone)
  const given = relayed.trim()
  if (ISO_LIKE.test(given)) {
    if (!ISO_WITH_OFFSET.test(given)) return false
    const givenMs = Date.parse(given)
    return Number.isFinite(givenMs) && classTimeLabel(givenMs, zone) === want
  }
  return normLabel(given) === normLabel(want)
}
