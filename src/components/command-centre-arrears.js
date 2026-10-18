// HATCHINV.1 — what the command centre's Arrears tile says.
//
// Glofox arrears (`signals.arrearsCents`) plus the EUR-only un1t.online figure
// the bundle ships as `un1t_billing.arrears_cents`. When un1t.online has flagged
// an overdue but reported no amount, the tile says so rather than reading €0
// beside a red "Payment overdue" chip. With no `un1t_billing` (or an empty one)
// the result is exactly the Glofox-only tile.

/**
 * @param {{ arrearsCents?: number, arrearsCount?: number }|null|undefined} signals
 * @param {{ overdue?: boolean, arrears_cents?: number }|null|undefined} un1tBilling
 * @returns {{ text: string, flagged: boolean }}  `flagged` = the amber styling
 */
export function arrearsTile(signals, un1tBilling) {
  const glofox = Number(signals?.arrearsCents) || 0
  const un1t = Number(un1tBilling?.arrears_cents) || 0
  const total = glofox + un1t
  const un1tOverdue = un1tBilling?.overdue === true
  const flagged = Number(signals?.arrearsCount) > 0 || un1tOverdue
  if (total > 0) return { text: `€${Math.round(total / 100)}`, flagged }
  if (un1tOverdue) return { text: 'amount not reported', flagged }
  return { text: '€0', flagged }
}
