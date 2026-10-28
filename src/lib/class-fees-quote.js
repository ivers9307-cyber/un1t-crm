// FEES.2 — what cancelling a booking right now would cost the member, for
// Mia's warning before a late cancellation (Richard, 28 Oct 2026). Reads
// only: never the write layer (Mia may not reach a charge,
// tests/mia-no-charge-no-refund-guard.test.js).
//
// The answer follows the same rules the 23:00 run applies: fees switched on
// at the studio, inside un1t.online's own window, the penalty by plan, and
// the forgiveness rules (a swap cannot be known yet, so it is left out; the
// warning tells the member that a move within the swap window is free).

import { classFeeSettingsFrom, penaltyFor } from './class-fees.js'
import { loadForgivenessFacts, decideForgiveness } from './class-fees-forgiveness.js'
import { getLocationZone } from './location-time.js'

/**
 * @param {object} db service-role client
 * @param {{ locationId: string, un1tUserId: string, bookingId: string, eventId: string|null,
 *   startsAt: string|null, creditCharged: boolean|null, readWindowHours: () => Promise<number|null>,
 *   nowMs?: number }} args  readWindowHours is called only when fees are on and the class has a start
 * @returns {Promise<{ applies: false, reason: string }
 *   | { applies: true, penalty: 'fee', amountCents: number, windowHours: number, swapMinutes: number|null }
 *   | { applies: true, penalty: 'credit_forfeit', windowHours: number, swapMinutes: number|null }>}
 *   Throws on a database error; the caller decides what an unreadable quote means.
 */
export async function lateCancelQuote(db, { locationId, un1tUserId, bookingId, eventId, startsAt, creditCharged, readWindowHours, nowMs = Date.now() }) {
  const { data: loc, error } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .maybeSingle()
  if (error) throw Object.assign(new Error(`late-cancel quote: location read failed (${error.code ?? 'no code'})`), { code: error.code })
  const settings = classFeeSettingsFrom(loc?.settings)
  if (!settings.enabled) return { applies: false, reason: 'fees_off' }

  const startMs = Date.parse(startsAt ?? '')
  if (!Number.isFinite(startMs)) return { applies: false, reason: 'no_start' }
  if (startMs <= nowMs) return { applies: false, reason: 'started' }
  const windowHours = await readWindowHours()
  if (!Number.isFinite(windowHours) || windowHours <= 0) return { applies: false, reason: 'no_window' }
  if (startMs - nowMs >= windowHours * 3_600_000) return { applies: false, reason: 'in_time' }

  const { data: client, error: cErr } = await db
    .from('un1t_clients')
    .select('un1t_user_id, credit_unlimited')
    .eq('location_id', locationId)
    .eq('un1t_user_id', un1tUserId)
    .maybeSingle()
  if (cErr) throw Object.assign(new Error(`late-cancel quote: client read failed (${cErr.code ?? 'no code'})`), { code: cErr.code })
  const penalty = penaltyFor({ credit_charged: creditCharged === true }, client)
  const swapMinutes = settings.forgiveness.swap.on ? settings.forgiveness.swap.minutes : null

  if (penalty === 'credit_forfeit') return { applies: true, penalty, windowHours, swapMinutes }
  if (!(settings.lateCancelFeeCents > 0)) return { applies: false, reason: 'no_amount' }

  // The forgiveness rules, as tonight's run would apply them (no swap yet).
  const rules = { ...settings.forgiveness, swap: { ...settings.forgiveness.swap, on: false }, spotRefilled: { on: false } }
  const offence = { bookingId, un1tUserId, eventId, kind: 'late_cancel', startsAt: new Date(startMs).toISOString(), cancelledAt: new Date(nowMs).toISOString() }
  const zone = await getLocationZone(db, locationId)
  const facts = await loadForgivenessFacts(db, { locationId, rules, offences: [offence] })
  const rule = decideForgiveness({ offences: [offence], facts, rules, zone }).get(bookingId)
  if (rule) return { applies: false, reason: `forgiven:${rule}` }

  return { applies: true, penalty: 'fee', amountCents: settings.lateCancelFeeCents, windowHours, swapMinutes }
}

const euro = (cents) => `€${(cents / 100).toFixed(2).replace(/\.00$/, '')}`

/** What Mia is told when a cancel needs the member's go-ahead first. Pure. */
export function lateCancelWarning(quote) {
  const hours = quote.windowHours === 1 ? '1 hour' : `${quote.windowHours} hours`
  const cost = quote.penalty === 'fee'
    ? `a ${euro(quote.amountCents)} late-cancellation fee will be charged to the card they have on file with the studio`
    : 'the class credit they used for it will not be given back'
  const move = quote.swapMinutes
    ? ` Offer to move them to another class instead: if they book another class within ${quote.swapMinutes} minutes of cancelling, no fee is charged.`
    : ' Offer to move them to another class or keep the booking instead.'
  return `NOT CANCELLED YET. This class starts within the studio's ${hours} cancellation window, so if they cancel now ${cost}. Tell the customer this plainly before anything else.${move} Only if they clearly say they still want to cancel, call cancel_class_booking again with the same booking_id and confirm_late_fee true. Never call it with confirm_late_fee true without that answer.`
}
