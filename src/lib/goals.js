// Goal progress computation. Supabase-fetched rows go in, progress numbers
// come out. Isolated so the dashboard card and /account/goals page share the
// math.
//
// ⚠️ THIS IS NOT A COPY OF shared/goals.js, whatever line 1 used to say.
// It claimed "KEEP IN SYNC with champ-app/shared/goals.js (verbatim copy
// below line 1)" and that was false: this file is PR #610's original, while
// shared/goals.js arrived with the Repset P1 champ-app drop (#1433).
//
// TZ.17 (⚠️, approved 11 Oct 2026) settled the boundary half of the old
// divergence: startOfIsoWeek / startOfMonth / computeProgress now bucket on the
// MEMBER's calendar (their home studio's zone, D7; omitted = Europe/Dublin),
// exactly as shared/goals.js does. They used UTC boundaries, so near midnight
// on a Monday (or the 1st) during Irish summer time the web credited a session
// to a different week or month than the phone did. What still differs is
// periodEnd's arity: (periodStart) here, (period, periodStart) there. It stays
// pinned in tests/shared-pair-sync.test.js (mode 'diverged'). Do not
// "resolve" it by editing this comment back.

import { productName } from '@/lib/brand-name'
import { weekStartMsIn, monthStartMsIn, DEFAULT_TZ } from '@/lib/location-time'

// Week / month buckets are calendar periods in `zone` — the MEMBER's zone,
// their home studio's (TZ.13/TZ.17, D7; omitted = Europe/Dublin): weeks start
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

export function periodEnd(periodStart) {
  const d = new Date(periodStart)
  // Add 7 days for week, or jump to next month start.
  // We don't know which without context — caller knows via goal.kind.
  return d
}
