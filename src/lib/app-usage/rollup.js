// USAGE.1 — rebuilding app_usage_daily from the raw sessions and visits, and
// retention. Run by /api/cron/app-usage-rollup every 15 minutes.
//
// Each run re-derives WHOLE days (today and yesterday in every zone in
// play) from the raw rows, so a late or re-sent batch, or a re-run of the
// cron, always converges on the same totals. Rows are upserted with this
// run's timestamp and then any row for those days the run did not touch is
// deleted, so the report never sees a day half-empty mid-rebuild.
//
// Time rules (design: docs/superpowers/specs/2026-10-26-app-usage-design.md):
//   - a day is the session's studio day (its location's zone, else the
//     platform zone), split at local midnight;
//   - '_session' rows carry the session count and the UNION of session
//     time, per platform and across both ('all'), so phone + web at once, or
//     two browser tabs, never count a minute twice;
//   - feature rows carry the visit count and the SUM of visit time;
//   - a visit or session that crosses midnight counts on each day it touches.

import { dateKeyIn, dayStartMsIn, addDaysIn, todayStrIn, PLATFORM_TZ } from '@shared/zoned-time'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'
export const RETENTION = Object.freeze({ rawDays: 90, dailyDays: 400 })
export const SESSION_FEATURE = '_session'
const DAY_MS = 86400_000
const PAGE = 1000
const CHUNK = 200

export function unionMs(spans) {
  const sorted = spans.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  let total = 0
  let curS = null
  let curE = null
  for (const [s, e] of sorted) {
    if (curE === null || s > curE) {
      if (curE !== null) total += curE - curS
      curS = s
      curE = e
    } else if (e > curE) {
      curE = e
    }
  }
  if (curE !== null) total += curE - curS
  return total
}

export function splitByDay(startMs, endMs, zone) {
  const parts = []
  let s = startMs
  while (s < endMs) {
    const day = dateKeyIn(s, zone)
    const nextStart = dayStartMsIn(addDaysIn(day, 1, zone), zone)
    const e = Math.min(endMs, nextStart)
    parts.push({ day, startMs: s, endMs: e })
    s = e
  }
  return parts
}

/** Today and yesterday in each zone: the days a run rebuilds. */
export function rebuildDays(nowMs, zones) {
  const days = new Set()
  for (const zone of new Set([PLATFORM_TZ, ...zones])) {
    const today = todayStrIn(zone, nowMs)
    days.add(today)
    days.add(addDaysIn(today, -1, zone))
  }
  return days
}

/**
 * Pure: raw sessions + visits → daily rows (without updated_at).
 * @param {{ sessions: object[], visits: object[], zoneFor: (locationId: string|null) => string }} args
 */
export function buildDailyRows({ sessions, visits, zoneFor }) {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const sessionSpans = new Map() // key → { base, spans[], count }
  const featureRows = new Map() // key → row

  const baseOf = (s, day, platform, feature) => ({
    profile_id: s.profile_id,
    day,
    platform,
    feature,
    location_id: s.location_id || null,
    location_key: s.location_id || NIL_UUID,
  })
  const keyOf = (b) => [b.profile_id, b.day, b.platform, b.feature, b.location_key].join('|')

  for (const s of sessions) {
    const zone = zoneFor(s.location_id)
    for (const part of splitByDay(Date.parse(s.started_at), Date.parse(s.ended_at), zone)) {
      for (const platform of [s.platform, 'all']) {
        const base = baseOf(s, part.day, platform, SESSION_FEATURE)
        const k = keyOf(base)
        if (!sessionSpans.has(k)) sessionSpans.set(k, { base, spans: [], count: 0 })
        const acc = sessionSpans.get(k)
        acc.spans.push([part.startMs, part.endMs])
        acc.count += 1
      }
    }
  }

  for (const v of visits) {
    const s = byId.get(v.session_id)
    if (!s) continue
    const zone = zoneFor(s.location_id)
    for (const part of splitByDay(Date.parse(v.started_at), Date.parse(v.ended_at), zone)) {
      const base = baseOf(s, part.day, s.platform, v.feature)
      const k = keyOf(base)
      if (!featureRows.has(k)) featureRows.set(k, { ...base, visits: 0, ms: 0 })
      const row = featureRows.get(k)
      row.visits += 1
      row.ms += part.endMs - part.startMs
    }
  }

  const rows = []
  for (const { base, spans, count } of sessionSpans.values()) {
    rows.push({ ...base, visits: count, seconds: Math.round(unionMs(spans) / 1000) })
  }
  for (const { ms, ...row } of featureRows.values()) {
    rows.push({ ...row, seconds: Math.round(ms / 1000) })
  }
  return rows
}

async function readAll(build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) throw new Error(`usage rollup read failed: ${error.code || error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) return out
  }
}

/**
 * The cron's work: rebuild today and yesterday, then retention.
 * @param {object} db service-role client
 * @param {{ nowMs: number, getZones: (ids: string[]) => Promise<Map<string,string>> }} opts
 * @returns {Promise<{ days: string[], sessions: number, rows: number, purged_sessions: number, purged_daily: number }>}
 */
export async function runUsageRollup(db, { nowMs, getZones }) {
  const runIso = new Date(nowMs).toISOString()
  // Any session that touches yesterday in any zone ended within the last
  // 72 h (yesterday starts at most 48 h + 14 h ago).
  const windowIso = new Date(nowMs - 72 * 3600_000).toISOString()

  const sessions = await readAll(() => db
    .from('app_usage_sessions')
    .select('id, profile_id, location_id, platform, started_at, ended_at')
    .gte('ended_at', windowIso)
    .order('id'))

  const visits = []
  for (let i = 0; i < sessions.length; i += CHUNK) {
    const ids = sessions.slice(i, i + CHUNK).map((s) => s.id)
    visits.push(...await readAll(() => db
      .from('app_usage_visits')
      .select('id, session_id, profile_id, feature, started_at, ended_at')
      .in('session_id', ids)
      .order('id')))
  }

  const zones = await getZones(sessions.map((s) => s.location_id).filter(Boolean))
  const zoneFor = (id) => (id && zones.get(id)) || PLATFORM_TZ
  const days = rebuildDays(nowMs, [...zones.values()])
  const rows = buildDailyRows({ sessions, visits, zoneFor })
    .filter((r) => days.has(r.day))
    .map((r) => ({ ...r, updated_at: runIso }))

  for (let i = 0; i < rows.length; i += PAGE) {
    const { error } = await db
      .from('app_usage_daily')
      .upsert(rows.slice(i, i + PAGE), { onConflict: 'profile_id,day,platform,feature,location_key' })
    if (error) throw new Error(`usage rollup write failed: ${error.code || error.message}`)
  }

  // Rows for the rebuilt days that this run did not write are stale (their
  // session was clamped away, or a feature total fell to nothing).
  const { error: staleErr } = await db
    .from('app_usage_daily')
    .delete()
    .in('day', [...days].sort())
    .lt('updated_at', runIso)
  if (staleErr) throw new Error(`usage rollup stale delete failed: ${staleErr.code || staleErr.message}`)

  const purged = await purgeOld(db, nowMs)
  return { days: [...days].sort(), sessions: sessions.length, rows: rows.length, ...purged }
}

async function purgeBatches(db, table, column, cutoff) {
  let total = 0
  for (let round = 0; round < 50; round++) {
    const { data, error } = await db.from(table).select('id').lt(column, cutoff).order('id').limit(PAGE)
    if (error) throw new Error(`usage retention read failed: ${error.code || error.message}`)
    if (!data || data.length === 0) return total
    const { error: delErr } = await db.from(table).delete().in('id', data.map((r) => r.id))
    if (delErr) throw new Error(`usage retention delete failed: ${delErr.code || delErr.message}`)
    total += data.length
    if (data.length < PAGE) return total
  }
  return total
}

/** Raw sessions (visits cascade) after 90 days, daily rows after 400. */
export async function purgeOld(db, nowMs) {
  const rawCutoff = new Date(nowMs - RETENTION.rawDays * DAY_MS).toISOString()
  const dailyCutoff = addDaysIn(todayStrIn(PLATFORM_TZ, nowMs), -RETENTION.dailyDays, PLATFORM_TZ)
  return {
    purged_sessions: await purgeBatches(db, 'app_usage_sessions', 'started_at', rawCutoff),
    purged_daily: await purgeBatches(db, 'app_usage_daily', 'day', dailyCutoff),
  }
}
