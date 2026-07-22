// euros ↔ integer cents for the operator price field. Storage is cents
// (price_cents on the class_funnel block); display is euros.
export function centsToEuros(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n) || n <= 0) return ''
  const euros = n / 100
  return String(Number(euros.toFixed(2))) // trim trailing zeros: 29 / 29.5
}

export function eurosToCents(input) {
  const n = Number(String(input).trim())
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 100)
}
