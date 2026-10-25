// Goal progress computation. Pure helpers — supabase-fetched
// rows go in, progress numbers come out. Isolated so the
// dashboard card and /account/goals page share the math.

import { weekStartMsIn, monthStartMsIn, dayStartMsIn, dateKeyIn, DEFAULT_TZ } from './zoned-time.js'
import { productName } from './brand-name.js'

const MS_DAY = 24 * 3600 * 1000

// Week / month buckets are calendar periods in `zone` — the MEMBER's zone,
// their home studio's (TZ.13, D7; omitted = Europe/Dublin): weeks start
// Monday 00:00 local, months on the 1st 00:00 local. A UTC boundary would
// credit a session at 00:30 Dublin on Monday to the PREVIOUS week during IST
// (it's 23:30 UTC Sunday) — the member would see it in the wrong "this week"
// total. Returns a Date at the local-midnight instant.
export function startOfIsoWeek(now = new Date(), zone = DEFAULT_TZ) {
  return new Date(weekStartMsIn(now instanceof Date ? now.getTime() : now, zone))
}
export function startOfMonth(now = new Date(), zone = DEFAULT_TZ) {
  return new Date(monthStartMsIn(now instanceof Date ? now.getTime() : now, zone))
}

// W1.S4 — the two points goals name the PRODUCT ("UN1T Points this week"),
// and the product name is the tenant's short brand, never a literal. Callers
// that render a label resolve the brand (getLocationBranding on the web,
// useBrand() on the phone) and read goalDefs(shortName); GOAL_DEFS is the
// brand-less default (bare "Points") for the unit / period / field /
// suggested lookups that never show a label.
export function goalDefs(shortName) {
  const points = productName(shortName, 'points')
  return {
    weekly_points: {
      label: `${points} this week`,
      unit: 'points',
      suggested: [200, 500, 1000, 1500, 2500],
      period: 'week',
      field: 'effort_points',
    },
    weekly_classes: {
      label: 'Classes this week',
      unit: 'classes',
      suggested: [2, 3, 4, 5, 6],
      period: 'week',
      field: 'classes',
    },
    monthly_points: {
      label: `${points} this month`,
      unit: 'points',
      suggested: [1000, 2500, 5000, 10000],
      period: 'month',
      field: 'effort_points',
    },
    monthly_classes: {
      label: 'Classes this month',
      unit: 'classes',
      suggested: [8, 12, 16, 20, 24],
      period: 'month',
      field: 'classes',
    },
  }
}

export const GOAL_DEFS = goalDefs('')

export const GOAL_KINDS = Object.keys(GOAL_DEFS)

/**
 * Sum the relevant field over sessions falling in the goal's period.
 * @param {object} goal  contact_goals row
 * @param {Array}  sessions  heart_rate_sessions array (any window — we filter)
 */
export function computeProgress(goal, sessions, now = new Date(), zone = DEFAULT_TZ) {
  const def = GOAL_DEFS[goal.kind]
  if (!def) return { current: 0, target: goal.target_value, pct: 0, periodStart: null }

  const periodStart = def.period === 'week' ? startOfIsoWeek(now, zone) : startOfMonth(now, zone)
  const startMs = periodStart.getTime()

  let current = 0
  for (const s of sessions || []) {
    const t = new Date(s.started_at || s.ended_at).getTime()
    if (!Number.isFinite(t)) continue
    if (t < startMs) continue
    if (def.field === 'classes') current += 1
    else if (def.field === 'effort_points') current += Number(s.effort_points) || 0
  }
  const target = goal.target_value
  const pct = target > 0 ? Math.min(1, current / target) : 0
  return { current, target, pct, periodStart, def }
}

export function periodEnd(period, periodStart, zone = DEFAULT_TZ) {
  const startMs = periodStart instanceof Date ? periodStart.getTime() : Number(periodStart)
  if (period === 'week') {
    // Re-anchor to the local midnight 7 calendar days later rather than
    // adding a flat 7*24h — a DST-transition week is 167h or 169h long,
    // and a flat add would land an hour off the next Monday midnight.
    const [y, m, d] = dateKeyIn(startMs + 7 * MS_DAY, zone).split('-').map(Number)
    return new Date(dayStartMsIn({ y, mo: m, d }, zone))
  }
  // month: first moment (00:00 local) of the next calendar month.
  const [y, m] = dateKeyIn(startMs, zone).split('-').map(Number)
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return new Date(dayStartMsIn({ y: nextY, mo: nextM, d: 1 }, zone))
}
