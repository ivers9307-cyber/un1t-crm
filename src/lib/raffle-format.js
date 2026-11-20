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

/** Every number in a run, one by one: `#041, #042, #043`. */
export function formatTicketList(first, last) {
  const out = []
  for (let n = Number(first); n <= Number(last); n++) out.push(formatTicketNumber(n))
  return out.join(', ')
}

/** "3 for €10" (whole euros drop the cents). */
export function optionLabel(tickets, priceCents) {
  const euros = (Number(priceCents) || 0) / 100
  const price = Number.isInteger(euros) ? String(euros) : euros.toFixed(2)
  return `${tickets} for €${price}`
}

/**
 * What a quantity costs: the cheapest ticket option for exactly that many
 * tickets, else price × quantity. The same rule as sell_raffle_tickets
 * (mig 865); the till shows this, the database charges it.
 * @returns {{ cents: number, label: string|null }}
 */
export function priceForQuantity(raffle, quantity) {
  const q = Number(quantity)
  let best = null
  for (const o of raffle?.ticket_options || []) {
    if (Number(o.tickets) === q && Number(o.price_cents) > 0 && (best === null || o.price_cents < best)) best = Number(o.price_cents)
  }
  if (best !== null) return { cents: best, label: optionLabel(q, best) }
  return { cents: (Number(raffle?.ticket_price_cents) || 0) * q, label: null }
}
