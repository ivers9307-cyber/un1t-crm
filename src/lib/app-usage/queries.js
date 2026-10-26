// USAGE.1 — the App usage report's reads (service role). The aggregation
// runs in the database (mig 778 functions) because a 12-month range is far
// past PostgREST's 1,000-row page; results are still paged with .range().

import { dayStartMsIn, addDaysIn, todayStrIn, PLATFORM_TZ } from '@shared/zoned-time'
import { uuidLike } from '@/lib/schemas'
import { loadUsageScope } from './scope'
import { rangeFor } from './report'

const PAGE = 1000
const CHUNK = 200

/** Who may read the report: a master on their own session. */
export function isUsageReportViewer(user) {
  return !!user && user.profileRole === 'master' && !user.impersonatingFrom && !user.supportSession
}

// The function name stays a literal at each call site (check:rpc-names reads
// it there).
async function rpcAll(fn, call) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await call().range(from, from + PAGE - 1)
    if (error) throw new Error(`app usage: ${fn} failed: ${error.code || error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) return out
  }
}

export async function readSummary(db, { from, to, profileIds, locationId = null }) {
  if (profileIds.length === 0) return []
  return rpcAll('app_usage_summary', () => db.rpc('app_usage_summary', {
    p_from: from, p_to: to, p_profile_ids: profileIds, p_location_id: locationId,
  }))
}

export async function readLastActive(db, profileIds) {
  if (profileIds.length === 0) return new Map()
  const rows = await rpcAll('app_usage_last_active', () => db.rpc('app_usage_last_active', { p_profile_ids: profileIds }))
  return new Map(rows.map((r) => [r.profile_id, r.last_active_at]))
}

/**
 * One person's sessions that overlap one platform-zone day, and their
 * visits, for the timeline.
 */
export async function readDay(db, { profileId, day, locationId = null }) {
  const startIso = new Date(dayStartMsIn(day, PLATFORM_TZ)).toISOString()
  const endIso = new Date(dayStartMsIn(addDaysIn(day, 1, PLATFORM_TZ), PLATFORM_TZ)).toISOString()
  let q = db
    .from('app_usage_sessions')
    .select('id, platform, location_id, started_at, ended_at')
    .eq('profile_id', profileId)
    .lt('started_at', endIso)
    .gte('ended_at', startIso)
  if (locationId) q = q.eq('location_id', locationId)
  const { data: sessions, error } = await q.order('started_at').range(0, PAGE - 1)
  if (error) throw new Error(`app usage: day sessions read failed: ${error.code || error.message}`)

  const visits = []
  const ids = (sessions || []).map((s) => s.id)
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error: vErr } = await db
      .from('app_usage_visits')
      .select('session_id, feature, started_at, ended_at')
      .in('session_id', ids.slice(i, i + CHUNK))
      .order('started_at')
      .range(0, PAGE - 1)
    if (vErr) throw new Error(`app usage: day visits read failed: ${vErr.code || vErr.message}`)
    visits.push(...(data || []))
  }
  return { sessions: sessions || [], visits }
}

/** Report filters from the query string; a malformed id is ignored. */
export function parseFilters(url) {
  const p = url.searchParams
  const id = (v) => (v && uuidLike.safeParse(v).success ? v : null)
  const platform = ['phone', 'web'].includes(p.get('platform')) ? p.get('platform') : 'all'
  return {
    rangeKey: p.get('range') || '7d',
    platform,
    organizationId: id(p.get('organization_id')),
    locationId: id(p.get('location_id')),
  }
}

/** Scope + summary for the chosen filters, with the studio narrowing applied. */
export async function loadReportData(db, filters, nowMs = Date.now()) {
  const range = rangeFor(filters.rangeKey, todayStrIn(PLATFORM_TZ, nowMs))
  const scope = await loadUsageScope(db, filters)
  const summary = await readSummary(db, {
    from: range.from, to: range.to, profileIds: scope.staff.map((s) => s.id), locationId: filters.locationId,
  })
  let staff = scope.staff
  if (filters.locationId) {
    const used = new Set(summary.filter((r) => Number(r.seconds) > 0).map((r) => r.profile_id))
    staff = staff.filter((s) => s.locationIds.has(filters.locationId) || used.has(s.id))
  }
  return { range, scope, staff, summary }
}
