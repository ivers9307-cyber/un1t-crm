// ROSTER-FIX.2 — leave-day maths shared by the time-off POST.
// Holiday counts Mon-Fri only, matching leaveHoursInWeek's Mon-Fri
// contract convention in roster-summary.js; other types count calendar days.
function addDay(iso) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10)
}
export function countLeaveDays(type, startIso, endIso) {
  let n = 0
  for (let cur = startIso; cur <= endIso; cur = addDay(cur)) {
    const dow = new Date(cur + 'T00:00:00Z').getUTCDay()
    if (type !== 'holiday' || (dow >= 1 && dow <= 5)) n++
  }
  return n
}
export function splitAtYearEnd(startIso, endIso) {
  if (startIso.slice(0, 4) === endIso.slice(0, 4)) return [[startIso, endIso]]
  const y = startIso.slice(0, 4)
  return [[startIso, `${y}-12-31`], [`${Number(y) + 1}-01-01`, endIso]]
}
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd
}
