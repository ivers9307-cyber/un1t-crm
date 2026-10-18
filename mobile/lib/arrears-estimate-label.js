// UN1TRADAR.2 — the phone's labels for an estimated arrears figure. At a
// un1t.online studio a past-due member whose amount un1t.online does not
// report counts at their subscription's price; any figure that includes such
// an estimate says so. A Glofox studio's text is unchanged. Pure, no imports.

export const ESTIMATE_NOTE = 'includes an estimate'

/** The note under the radar's "Overdue value" row, or null when the total is exact. */
export function overdueValueNote(churn) {
  return churn?.overdueValueEstimated === true ? ESTIMATE_NOTE : null
}

/** The business dashboard's "In arrears" sublabel. */
export function arrearsSublabel(arrearsData) {
  if (!arrearsData) return 'arrears unavailable'
  const n = arrearsData.memberCount
  const base = `${n} member${n === 1 ? '' : 's'}`
  return arrearsData.estimated === true ? `${base}, ${ESTIMATE_NOTE}` : base
}
