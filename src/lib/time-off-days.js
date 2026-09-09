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
// ROSTER-FIX.2 — a range can straddle more than one 31 December, and the
// single-cut version returned a SECOND segment that still spanned years, so
// every day after the first new year was charged to one allowance. Peel one
// year at a time until what is left sits inside a single year. The `<`
// comparison (not `!==`) also terminates on an inverted range.
export function splitAtYearEnd(startIso, endIso) {
  const out = []
  let cur = startIso
  while (cur.slice(0, 4) < endIso.slice(0, 4)) {
    const y = Number(cur.slice(0, 4))
    out.push([cur, `${y}-12-31`])
    cur = `${y + 1}-01-01`
  }
  out.push([cur, endIso])
  return out
}
