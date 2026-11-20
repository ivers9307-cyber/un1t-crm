// RAFFLE.1 — display helpers shared by the server routes and the till page.
// Kept free of server imports so the browser bundle can load it.

/** `#007`; numbers past three digits are shown in full. */
export function formatTicketNumber(n) {
  return `#${String(Number(n)).padStart(3, '0')}`
}

/** `#041` for one ticket, `#041–#043` for a run. */
export function formatTicketRange(first, last) {
  return Number(first) === Number(last)
    ? formatTicketNumber(first)
    : `${formatTicketNumber(first)}–${formatTicketNumber(last)}`
}

/** €15.00 */
export function formatEuros(cents, currency = 'EUR') {
  const amount = (Number(cents) || 0) / 100
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(amount)
  } catch {
    return `€${amount.toFixed(2)}`
  }
}
