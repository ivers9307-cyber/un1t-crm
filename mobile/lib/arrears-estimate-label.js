// UN1TRADAR.2 — the phone's labels for an estimated arrears figure. At a
// un1t.online studio a past-due member whose amount un1t.online does not
// report counts at their subscription's price; any figure that includes such
// an estimate says so. A Glofox studio's text is unchanged. Pure, no imports.

export const ESTIMATE_NOTE = 'includes an estimate'
// A figure with no known euro amount prints these words, never "€0" (the web's
// AMOUNT_UNAVAILABLE in src/lib/radar-copy.js; parity in tests/estimate-note-parity.test.js).
export const AMOUNT_UNAVAILABLE = 'amount not available from un1t.online'

/**
 * `format(cents)`, or AMOUNT_UNAVAILABLE when the figure contains an estimate or
 * an unknown amount and does not sum above 0 (the web's amountOrUnavailable).
 */
export function amountOrUnavailable(cents, { estimated = false, unknown = false } = {}, format = (c) => String(c)) {
  if ((estimated === true || unknown === true) && !(Number(cents) > 0)) return AMOUNT_UNAVAILABLE
  return format(cents)
}

const noKnownOverdueValue = (churn) => churn?.overdueValueEstimated === true && !(Number(churn?.overdueValueCents) > 0)

/** The note under the radar's "Overdue value" row, or null when the total is exact or has no number. */
export function overdueValueNote(churn) {
  return churn?.overdueValueEstimated === true && !noKnownOverdueValue(churn) ? ESTIMATE_NOTE : null
}

/** The radar's "Overdue value" row value: `formatCents(cents)`, or AMOUNT_UNAVAILABLE. */
export function overdueValueText(churn, formatCents) {
  return amountOrUnavailable(churn?.overdueValueCents, { estimated: churn?.overdueValueEstimated === true }, formatCents)
}

/** The business dashboard's "In arrears" value: `formatEuros(euros)`, AMOUNT_UNAVAILABLE, or '—' without data. */
export function arrearsCardValue(arrearsData, formatEuros) {
  if (!arrearsData) return '—'
  return amountOrUnavailable(arrearsData.totalCents, { estimated: arrearsData.estimated === true }, (c) => formatEuros(c / 100))
}

/** The business dashboard's "In arrears" sublabel. */
export function arrearsSublabel(arrearsData) {
  if (!arrearsData) return 'arrears unavailable'
  const n = arrearsData.memberCount
  const base = `${n} member${n === 1 ? '' : 's'}`
  return arrearsData.estimated === true ? `${base}, ${ESTIMATE_NOTE}` : base
}
