// Display a minor-unit amount (cents) as money. Used by staff-facing surfaces
// (approvals, review page). Distinct from price-format.js (editor input parsing).
const SYMBOLS = { EUR: '€', GBP: '£' }

export function formatMoneyMinor(amountCents, currency = 'EUR') {
  const n = Number(amountCents)
  if (!Number.isFinite(n) || n <= 0) return ''
  const major = n / 100
  // Whole amounts drop the decimals (€29); fractional show two (€29.50).
  const body = Number.isInteger(major) ? String(major) : major.toFixed(2)
  const symbol = SYMBOLS[currency]
  if (symbol) return `${symbol}${body}`
  return `${currency} ${major.toFixed(2)}`
}
