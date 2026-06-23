// Pure helpers for the personal-roster MONTH view (Today dashboard).
// No IO — fetch happens in dashboard-data.js; these shape the rows for
// the web calendar grid + mobile agenda. Dates are ISO YYYY-MM-DD.
// Calendar month is Mon-start to match the existing week panels.

function isoOf(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Calendar month containing the anchor ISO date.
export function monthBounds(anchorIso) {
  const d = new Date(anchorIso + 'T00:00:00Z')
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return { monthStartIso: isoOf(start), monthEndIso: isoOf(end) }
}

// Rolling N-week window for the Today dashboard roster: the Monday of the week
// containing `anchorIso`, spanning `weeks` Mon-start weeks (default 5 = this
// week + the next 4). Returns the SAME { monthStartIso, monthEndIso } shape as
// monthBounds so dashboard-data + buildMonthMatrix consume it unchanged — fed
// contiguous Monday→Sunday bounds, buildMonthMatrix yields exactly `weeks` full
// rows with every day inMonth (no calendar-month padding).
export function upcomingWeeksBounds(anchorIso, weeks = 5) {
  const d = new Date(anchorIso + 'T00:00:00Z')
  const sinceMonday = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  const start = new Date(d)
  start.setUTCDate(d.getUTCDate() - sinceMonday)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + weeks * 7 - 1)
  return { monthStartIso: isoOf(start), monthEndIso: isoOf(end) }
}

// Effective minutes for a shift, honouring overrides; wraps past midnight.
function durationMins(shift) {
  const start = shift.start_time_override || shift.shift_templates?.start_time
  const end = shift.end_time_override || shift.shift_templates?.end_time
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  return mins
}
export function shiftDurationHours(shift) {
  return Math.round((durationMins(shift) / 60) * 10) / 10
}
export function summariseShifts(shifts) {
  const list = shifts || []
  const hours = Math.round(list.reduce((t, s) => t + durationMins(s), 0) / 60 * 10) / 10
  return { count: list.length, hours }
}

// Mon-start weeks covering the whole month, padded with leading/trailing
// days from adjacent months (inMonth:false). Each cell:
// { iso, dayNum, inMonth, isToday, isPast, weekday(0=Mon), shifts[] }.
export function buildMonthMatrix(monthStartIso, monthEndIso, shifts, todayIso) {
  const byDate = {}
  for (const s of shifts || []) {
    if (!s.shift_date) continue
    ;(byDate[s.shift_date] ||= []).push(s)
  }
  const start = new Date(monthStartIso + 'T00:00:00Z')
  const end = new Date(monthEndIso + 'T00:00:00Z')
  // Back up to the Monday on/just before the 1st (getUTCDay: 0=Sun..6=Sat).
  const lead = (start.getUTCDay() + 6) % 7
  const gridStart = new Date(start); gridStart.setUTCDate(start.getUTCDate() - lead)
  // Forward to the Sunday on/just after the last day.
  const trail = (7 - ((end.getUTCDay() + 6) % 7) - 1)
  const gridEnd = new Date(end); gridEnd.setUTCDate(end.getUTCDate() + trail)

  const weeks = []
  let cur = new Date(gridStart)
  while (cur <= gridEnd) {
    const row = []
    for (let i = 0; i < 7; i++) {
      const iso = isoOf(cur)
      row.push({
        iso,
        dayNum: cur.getUTCDate(),
        weekday: (cur.getUTCDay() + 6) % 7,
        inMonth: iso >= monthStartIso && iso <= monthEndIso,
        isToday: iso === todayIso,
        isPast: iso < todayIso,
        shifts: byDate[iso] || [],
      })
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
    weeks.push(row)
  }
  return weeks
}
