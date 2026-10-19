// UN1TRADAR.2 — staff copy for radar figures un1t.online cannot supply.
//
// Pure (no I/O); the radar page, the digest, the briefing and the business
// card all read these, so a figure un1t.online does not expose renders the same
// words everywhere and never as 0, and every total that contains an estimate
// says so. No em-dashes (staff copy rule).
import { timeLabelIn } from '@shared/zoned-time'

export const UN1T_UNAVAILABLE = 'not available from un1t.online'
export const ESTIMATE_NOTE = 'includes an estimate'
export const AMOUNT_UNAVAILABLE = 'amount not available from un1t.online'

const euros = (cents) => `€${Math.round((Number(cents) || 0) / 100).toLocaleString('en-IE')}`

/** A count, or UN1T_UNAVAILABLE for a source that cannot read it (null). Undefined is 0, as before. */
export function countOrUnavailable(n) {
  if (n === null) return UN1T_UNAVAILABLE
  return String(Number(n) || 0)
}

/**
 * One member's amount owed. `estimated`: un1t.online reported no amount and
 * the subscription price stands in. `unknown`: the debt has no euro figure at
 * all (no price, another currency), so no number is printed.
 */
export function owedLabel(cents, { estimated = false, unknown = false } = {}) {
  if (unknown) return AMOUNT_UNAVAILABLE
  if (estimated) return `about ${euros(cents)} (estimate: amount not reported by un1t.online)`
  return euros(cents)
}

/** A summed total; one containing an estimate (or an amount with no euro figure) says so. */
export function totalLabel(cents, { estimated = false } = {}) {
  if (!estimated) return euros(cents)
  // every figure in it unknown: no number, never "€0"
  if (!(Number(cents) > 0)) return AMOUNT_UNAVAILABLE
  return `${euros(cents)}, ${ESTIMATE_NOTE}`
}

/**
 * A card's money value: `format(cents)`, or AMOUNT_UNAVAILABLE when the figure
 * has no known euro amount (it contains an estimate or an unknown amount and
 * does not sum above 0), the same rule as totalLabel. Glofox never sets either
 * flag, so its value is `format(cents)` exactly as before.
 */
export function amountOrUnavailable(cents, { estimated = false, unknown = false } = {}, format = euros) {
  if ((estimated === true || unknown === true) && !(Number(cents) > 0)) return AMOUNT_UNAVAILABLE
  return format(cents)
}

/** "un1t.online data as of HH:MM" on `zone`'s clock, or null when there is no sync time. */
export function syncedAtLine(iso, zone) {
  const hm = timeLabelIn(iso, zone)
  return hm ? `un1t.online data as of ${hm}` : null
}

/** The radar's Overdue stat card breakdown: '€X owed', plus the estimate note. */
export function overdueCardBreakdown(summary) {
  const base = `${euros(summary?.overdueValueCents)} owed`
  if (summary?.overdueValueEstimated !== true) return base
  return Number(summary.overdueValueCents) > 0 ? `${base}, ${ESTIMATE_NOTE}` : totalLabel(0, { estimated: true })
}

/** One Overdue / Unpaid / Awaiting row's amount pill text. */
export function rowAmountLabel(m, { awaiting = false } = {}) {
  if (awaiting) return `${euros(m?.amountOwedCents)} awaiting authorization`
  if (m?.amountUnknown === true || m?.amountEstimated === true) {
    return owedLabel(m.amountOwedCents, { estimated: m.amountEstimated === true, unknown: m.amountUnknown === true })
  }
  return `${euros(m?.amountOwedCents)} owed`
}

/** The business briefing's arrears item: 'N in arrears (€X)', plus the estimate note. */
export function arrearsBriefingLabel(a) {
  return `${a.memberCount} in arrears (${totalLabel(a.totalCents, { estimated: a.estimated === true })})`
}
