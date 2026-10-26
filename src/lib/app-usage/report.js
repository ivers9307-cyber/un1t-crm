// USAGE.1 — shaping the App usage report (platform console,
// /admin/app-usage). Pure: the routes read the summary through
// public.app_usage_summary / app_usage_last_active (mig 778) and the raw
// rows for the timeline, and hand them here.
//
// Definitions (design: docs/superpowers/specs/2026-10-26-app-usage-design.md):
//   - time in app = the union of session time ('_session' rows), so phone and
//     web at once never count twice; per platform when one is chosen;
//   - sessions a day = sessions / days in the range;
//   - visits a day = visits to a feature / days in the range ("times a day");
//   - average visit = feature time / visits.

import { addDaysIn, PLATFORM_TZ } from '@shared/zoned-time'
import { usageFeatureLabel } from '@shared/usage-features'

export const RANGE_KEYS = ['today', '7d', '30d', '90d', '12m']
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12m': 365 }
export const SESSION_FEATURE = '_session'

export function rangeFor(key, todayStr) {
  const k = RANGE_KEYS.includes(key) ? key : '7d'
  const days = RANGE_DAYS[k]
  return { key: k, from: addDaysIn(todayStr, -(days - 1), PLATFORM_TZ), to: todayStr, days }
}

function index(summary) {
  const map = new Map()
  for (const r of summary) map.set(`${r.profile_id}|${r.platform}|${r.feature}`, r)
  return (profileId, platform, feature) => map.get(`${profileId}|${platform}|${feature}`)
}

const num = (v) => Number(v) || 0

export function peopleRows({ staff, summary, lastActive, days, platform }) {
  const get = index(summary)
  const sessionPlatform = platform === 'phone' || platform === 'web' ? platform : 'all'
  return staff.map((p) => {
    const s = get(p.id, sessionPlatform, SESSION_FEATURE)
    const phoneSeconds = num(get(p.id, 'phone', SESSION_FEATURE)?.seconds)
    const webSeconds = num(get(p.id, 'web', SESSION_FEATURE)?.seconds)
    const sessions = num(s?.visits)
    return {
      profileId: p.id,
      name: p.name,
      tenant: p.tenant || null,
      lastActiveAt: lastActive.get(p.id) || null,
      daysUsed: num(s?.days),
      sessions,
      sessionsPerDay: days > 0 ? sessions / days : 0,
      seconds: num(s?.seconds),
      phoneSeconds,
      webSeconds,
      phoneShare: phoneSeconds + webSeconds > 0 ? phoneSeconds / (phoneSeconds + webSeconds) : null,
    }
  }).sort((a, b) => b.seconds - a.seconds || String(a.name).localeCompare(String(b.name)))
}

export function featureRows({ summary, days, platform }) {
  const platforms = platform === 'phone' || platform === 'web' ? [platform] : ['phone', 'web']
  const byFeature = new Map()
  for (const r of summary) {
    if (r.feature === SESSION_FEATURE || !platforms.includes(r.platform)) continue
    if (!byFeature.has(r.feature)) byFeature.set(r.feature, { feature: r.feature, people: new Set(), visits: 0, seconds: 0 })
    const f = byFeature.get(r.feature)
    f.visits += num(r.visits)
    f.seconds += num(r.seconds)
    if (num(r.seconds) > 0) f.people.add(r.profile_id)
  }
  return [...byFeature.values()]
    .filter((f) => f.visits > 0)
    .map((f) => ({
      feature: f.feature,
      label: usageFeatureLabel(f.feature),
      people: f.people.size,
      visits: f.visits,
      visitsPerDay: days > 0 ? f.visits / days : 0,
      seconds: f.seconds,
      avgVisitSec: Math.round(f.seconds / f.visits),
    }))
    .sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label))
}

export function reportTotals({ people, features }) {
  return {
    activeStaff: people.filter((p) => p.seconds > 0).length,
    staffCount: people.length,
    sessions: people.reduce((n, p) => n + p.sessions, 0),
    seconds: people.reduce((n, p) => n + p.seconds, 0),
    topFeature: features[0]?.label || null,
  }
}

export function timeline({ sessions, visits }) {
  const bySession = new Map()
  for (const v of visits) {
    if (!bySession.has(v.session_id)) bySession.set(v.session_id, [])
    bySession.get(v.session_id).push(v)
  }
  const byStart = (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)
  return [...sessions].sort(byStart).map((s) => ({
    sessionId: s.id,
    platform: s.platform,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    trail: (bySession.get(s.id) || []).sort(byStart).map((v) => ({
      feature: v.feature,
      label: usageFeatureLabel(v.feature),
      seconds: Math.round((Date.parse(v.ended_at) - Date.parse(v.started_at)) / 1000),
    })),
  }))
}
