// Pure merge of the member's heart_rate_sessions and their personal-only Strava
// activities (mig 308) into ONE date-sorted list for the Sessions screen.
//
// PERSONAL-ONLY (Strava API Policy §5.4): the Sessions tab is the member's own
// private, RLS-scoped view, so showing Strava there is allowed — but it is
// DISPLAY-ONLY. Strava items are tagged kind 'strava', carry NO effort_points
// and NO zone data, never link to a heart_rate_sessions detail (there isn't
// one), and this helper is never consumed by any cross-member / leaderboard /
// feed surface. heart_rate_sessions stays the sole points + community store.
//
// Each returned item is { kind, key, sortMs, session? , activity? } — the
// original row is nested untouched under `.session` / `.activity` so the row
// components keep their existing field access.

const toMs = (iso) => {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function buildSessionsList({ sessions = [], stravaActivities = [] } = {}) {
  const items = []

  for (const s of sessions || []) {
    items.push({ kind: 'session', key: `session:${s.id}`, sortMs: toMs(s.started_at), session: s })
  }

  for (const a of stravaActivities || []) {
    items.push({ kind: 'strava', key: `strava:${a.strava_activity_id}`, sortMs: toMs(a.started_at), activity: a })
  }

  // Newest first; rows with no usable timestamp fall to the end.
  items.sort((x, y) => {
    if (x.sortMs == null && y.sortMs == null) return 0
    if (x.sortMs == null) return 1
    if (y.sortMs == null) return -1
    return y.sortMs - x.sortMs
  })

  return items
}
