// CHARITYENTRY.1 — "Entrants choose their entry amount" on a charity day.
//
// When an event has Charity day on AND `charity.entry_choose_amount` set, the
// person registering types a per-person amount instead of paying the fixed
// ticket price. The event's own ticket price (non_member_fee_cents) becomes
// the SUGGESTED amount the box starts on; `charity.entry_min_cents` is the
// floor; the ceiling is the donation maximum. Everyone on the entry pays the
// same chosen amount (member pricing and price tiers do not apply while it is
// on). Pure: no IO, shared by the public route, the register route and the
// signup widget so all three agree.

/** Default floor when the operator leaves the minimum blank: €5. */
export const ENTRY_AMOUNT_DEFAULT_MIN_CENTS = 500
/** Ceiling per person: €5,000, the same as the donation maximum default. */
export const ENTRY_AMOUNT_MAX_CENTS = 500000

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * The event's choose-your-amount settings, or `{ enabled: false }`.
 * Off for lead_gen (no payment) and whenever Charity day is off.
 * @returns {{ enabled: false } | { enabled: true, min_cents: number, max_cents: number, suggested_cents: number }}
 */
export function resolveEntryAmountSettings(race) {
  const c = race?.charity && typeof race.charity === 'object' && !Array.isArray(race.charity) ? race.charity : {}
  if (!race?.charity_enabled || c.entry_choose_amount !== true || race?.kind === 'lead_gen') return { enabled: false }
  const max = ENTRY_AMOUNT_MAX_CENTS
  const min = Math.min(positiveInt(c.entry_min_cents) ?? ENTRY_AMOUNT_DEFAULT_MIN_CENTS, max)
  const price = positiveInt(race?.non_member_fee_cents)
  const suggested = Math.min(Math.max(price ?? min, min), max)
  return { enabled: true, min_cents: min, max_cents: max, suggested_cents: suggested }
}

/**
 * Judge a chosen per-person amount (cents) against the settings.
 * @returns {{ ok: true, cents: number } | { ok: false, error: string }}
 */
export function validateEntryAmount(settings, cents, fmt = (c) => `€${(c / 100).toFixed(2)}`) {
  if (!settings?.enabled) return { ok: false, error: 'This event has a fixed price.' }
  const n = Number(cents)
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'Enter the amount you would like to pay.' }
  if (n < settings.min_cents) return { ok: false, error: `The minimum entry is ${fmt(settings.min_cents)} per person.` }
  if (n > settings.max_cents) return { ok: false, error: `The most we can take online is ${fmt(settings.max_cents)} per person.` }
  return { ok: true, cents: n }
}

/**
 * The race as computeTeamPricing should see it once an amount is chosen:
 * everyone pays the chosen amount as the (only) per-person fee.
 */
export function priceRaceAtChosenAmount(race, cents) {
  return { ...race, member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: cents }
}

/** Euros typed in a box -> whole cents, or null when it is not a positive amount. */
export function eurosToCents(text) {
  const s = String(text ?? '').trim().replace(',', '.')
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  return cents > 0 ? cents : null
}
