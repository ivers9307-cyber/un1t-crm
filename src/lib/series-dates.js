// series-dates — HOSTSERIES.1: the date runs behind "Make this a series".
// Calendar arithmetic on YYYY-MM-DD strings (Date.UTC in, slice out): a date,
// never an instant, so no zone is involved.

function parts(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)

/** `n` dates after `start`, `stepDays` apart (7 = weekly, 14 = fortnightly). */
export function weeklyDates(start, n, stepDays = 7) {
  const p = parts(start)
  if (!p || !(n > 0)) return []
  return Array.from({ length: n }, (_, i) => iso(p[0], p[1] - 1, p[2] + stepDays * (i + 1)))
}

/** `n` dates after `start`, one per month on the same day of the month,
 * clamped to the month's last day (31 Dec → 28 Feb). */
export function monthlyDates(start, n) {
  const p = parts(start)
  if (!p || !(n > 0)) return []
  return Array.from({ length: n }, (_, i) => {
    const monthIndex = p[1] - 1 + (i + 1)
    const lastDay = new Date(Date.UTC(p[0], monthIndex + 1, 0)).getUTCDate()
    return iso(p[0], monthIndex, Math.min(p[2], lastDay))
  })
}
