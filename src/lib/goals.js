// Goal progress computation. Supabase-fetched rows go in, progress numbers
// come out. Isolated so the dashboard card and /account/goals page share the
// math.
//
// ⚠️ THIS IS NOT A COPY OF shared/goals.js, whatever line 1 used to say.
// It claimed "KEEP IN SYNC with champ-app/shared/goals.js (verbatim copy
// below line 1)" and that was false: this file is PR #610's original, while
// shared/goals.js arrived with the Repset P1 champ-app drop (#1433), and the
// two differ in ways that matter —
//
//   • startOfIsoWeek / startOfMonth bucket on **UTC** boundaries here and on
//     **Europe/Dublin** boundaries in shared/. Near midnight on a Monday
//     during IST the two credit the same session to different weeks.
//   • periodEnd takes (periodStart) here and (period, periodStart) there.
//
// The web dashboard reads `@/lib/goals`; the mobile member app reads
// `shared/goals`. Both render the SAME member's weekly goal progress, so the
// divergence is live and member-visible. It is pinned as a known divergence
// in tests/shared-pair-sync.test.js (mode 'diverged') rather than papered
// over: deciding which boundary is correct moves a number members already
// see, and belongs in its own change. Do not "resolve" it by editing this
// comment back.

const MS_DAY = 24 * 3600 * 1000

// ISO week starts Monday 00:00 UTC. We display the week label in
// the user's timezone; the bucket boundary stays UTC for simplicity.
export function startOfIsoWeek(now = new Date()) {
  const d = new Date(now)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - day)
  return d
}
export function startOfMonth(now = new Date()) {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

export const GOAL_DEFS = {
  weekly_points: {
    label: 'UN1T points this week',
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
    label: 'UN1T points this month',
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

export const GOAL_KINDS = Object.keys(GOAL_DEFS)

/**
 * Sum the relevant field over sessions falling in the goal's period.
 * @param {object} goal  contact_goals row
 * @param {Array}  sessions  heart_rate_sessions array (any window — we filter)
 */
export function computeProgress(goal, sessions, now = new Date()) {
  const def = GOAL_DEFS[goal.kind]
  if (!def) return { current: 0, target: goal.target_value, pct: 0, periodStart: null }

  const periodStart = def.period === 'week' ? startOfIsoWeek(now) : startOfMonth(now)
  const startMs = periodStart.getTime()

  let current = 0
  for (const s of sessions || []) {
    const t = new Date(s.started_at || s.ended_at).getTime()
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
