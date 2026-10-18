// HATCHINV.1 — what an Arrears tile says when un1t.online is involved. One rule,
// shared by the inbox command centre and the contact-page header band.
//
// The figure is Glofox arrears plus the EUR-only un1t.online sum. un1t.online
// can also flag a member overdue without a usable EUR amount (none reported, or
// only a foreign-currency one); the tile never turns that into "€0" and never
// hides it behind a partial sum:
//   total 0 and overdue          -> "amount not reported" / "amount not in EUR"
//   total > 0, a row unreported  -> "€X + amount not reported" / "+ amount not in EUR"
// With no un1t facts (Stillorgan) the result is exactly the Glofox-only tile.

/**
 * How one overdue row's amount counts toward a EUR figure.
 * 'eur' = a positive EUR amount; 'not_eur' = a positive amount in another
 * currency; 'unreported' = no usable amount (or an amount with no currency).
 * @param {{ amountCents?: number|null, currency?: string|null }|null|undefined} pastDue
 * @returns {'eur'|'not_eur'|'unreported'}
 */
export function overdueAmountKind(pastDue) {
  const cents = pastDue?.amountCents
  if (!Number.isFinite(cents) || cents <= 0 || !pastDue?.currency) return 'unreported'
  return String(pastDue.currency).toUpperCase() === 'EUR' ? 'eur' : 'not_eur'
}

/** The words for a missing EUR amount: foreign-currency only vs nothing reported. */
export const amountNote = (notEur) => (notEur ? 'amount not in EUR' : 'amount not reported')

/**
 * @param {{ arrearsCents?: number, arrearsCount?: number }|null|undefined} signals
 *   `arrearsCents` is the figure to start from (Glofox, or already merged)
 * @param {{ overdue?: boolean, arrears_cents?: number, amount_unreported?: boolean, amount_not_eur?: boolean }|null|undefined} un1tBilling
 * @returns {{ text: string, flagged: boolean }}  `flagged` = the amber styling
 */
export function arrearsTile(signals, un1tBilling) {
  const glofox = Number(signals?.arrearsCents) || 0
  const un1t = Number(un1tBilling?.arrears_cents) || 0
  const total = glofox + un1t
  const un1tOverdue = un1tBilling?.overdue === true
  const flagged = Number(signals?.arrearsCount) > 0 || un1tOverdue
  const note = amountNote(un1tBilling?.amount_not_eur === true)
  const unreported = un1tOverdue && un1tBilling?.amount_unreported === true
  if (total > 0) return { text: `€${Math.round(total / 100)}${unreported ? ` + ${note}` : ''}`, flagged }
  if (un1tOverdue) return { text: note, flagged }
  return { text: '€0', flagged }
}
