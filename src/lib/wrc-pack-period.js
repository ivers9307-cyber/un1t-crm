// WRCPACK.1 — the pack's default period, pure and client-safe (the Reporting
// tab's card and the route both read it; src/lib/wrc-pack.js re-exports it
// and is server-only because of its reads).
//
// WRCPERIOD.1 — the pack's own cap. The other reports stop at 366 days
// (MAX_REPORT_DAYS: the coverage report walks every day), but a WRC inspector
// may ask for the records an employer must keep under s.25 of the Organisation
// of Working Time Act: THREE years. The pack walks no days (every read is
// paged and the shift read has its own 20k hard limit per studio), so it takes
// up to 1,096 days (three years, one of them leap). The card judges the same
// rule before offering the links, so a period the route would refuse never
// becomes a download of a JSON error (how the cap first surfaced: 1 Jun 2025
// to 20 Oct 2026, 507 days, saved as "wrc-pack.json").

export const WRC_PACK_MAX_DAYS = 1096

const DAY_MS = 86_400_000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The 12 months ending on `to`, inclusive: the same calendar day a year earlier, plus one day (29 Feb → 2 Mar). */
export function defaultWrcPeriod(to) {
  const [y, m, d] = to.split('-').map(Number)
  const from = new Date(Date.UTC(y - 1, m - 1, d + 1)).toISOString().slice(0, 10)
  return { from, to }
}

function realIsoDate(s) {
  if (!ISO_DAY.test(String(s || ''))) return false
  const ms = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s
}

/** Inclusive day count of a period; null when either end is not a real date. */
export function wrcPeriodDays(from, to) {
  if (!realIsoDate(from) || !realIsoDate(to)) return null
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/**
 * Why the card should not offer a download for this period, or null. The
 * same three rules the route applies (reportPeriodError with the pack's cap),
 * in the card's own words; the route stays the authority.
 */
export function wrcPeriodError(from, to) {
  const days = wrcPeriodDays(from, to)
  if (days === null) return 'Pick a real From and To date.'
  if (days < 1) return 'To must be on or after From.'
  if (days > WRC_PACK_MAX_DAYS) return `The pack covers at most three years (${WRC_PACK_MAX_DAYS} days); this period is ${days} days.`
  return null
}
