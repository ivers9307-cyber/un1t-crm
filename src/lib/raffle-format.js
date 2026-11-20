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
 * The units a quantity can be built from: one ticket at the single price, then
 * the options (2+ tickets, a price), in ticket order. The order matters: the
 * cheapest-mix search keeps the FIRST unit that reaches a cost, and
 * sell_raffle_tickets (mig 867) walks the units in this same order, so the
 * till, the online card and the database always agree.
 */
export function pricingUnits(raffle) {
  const single = { tickets: 1, price_cents: Number(raffle?.ticket_price_cents) || 0 }
  const options = (raffle?.ticket_options || [])
    .map((o) => ({ tickets: Number(o.tickets), price_cents: Number(o.price_cents) }))
    .filter((o) => Number.isInteger(o.tickets) && o.tickets >= 2 && o.price_cents > 0)
    .sort((a, b) => a.tickets - b.tickets || a.price_cents - b.price_cents)
  return [single, ...options]
}

/**
 * What a quantity costs: the cheapest mix of ticket options and single
 * tickets that makes exactly that many (20 tickets with "10 for €25" is two of
 * them, €50). The label names the deals used ("2 × 10 for €25",
 * "5 for €12 + 2 singles"), or is null when only single tickets were used.
 * The same rule as sell_raffle_tickets (mig 867); the till and the online card
 * show this, the database charges it.
 * @returns {{ cents: number, label: string|null }}
 */
export function priceForQuantity(raffle, quantity) {
  const q = Math.max(0, Math.floor(Number(quantity) || 0))
  const units = pricingUnits(raffle)
  const cost = new Array(q + 1).fill(Infinity)
  const pick = new Array(q + 1).fill(-1)
  cost[0] = 0
  for (let n = 1; n <= q; n++) {
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      if (u.tickets <= n && cost[n - u.tickets] + u.price_cents < cost[n]) {
        cost[n] = cost[n - u.tickets] + u.price_cents
        pick[n] = i
      }
    }
  }
  const counts = new Array(units.length).fill(0)
  for (let n = q; n > 0; n -= units[pick[n]].tickets) counts[pick[n]] += 1
  return { cents: q === 0 ? 0 : cost[q], label: mixLabel(units, counts) }
}

function mixLabel(units, counts) {
  const parts = []
  for (let i = units.length - 1; i >= 1; i--) {
    if (!counts[i]) continue
    const deal = optionLabel(units[i].tickets, units[i].price_cents)
    parts.push(counts[i] > 1 ? `${counts[i]} × ${deal}` : deal)
  }
  if (!parts.length) return null
  if (counts[0]) parts.push(`${counts[0]} single${counts[0] === 1 ? '' : 's'}`)
  return parts.join(' + ')
}
