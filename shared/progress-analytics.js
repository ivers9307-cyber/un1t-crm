// progress-analytics.js — pure multi-session aggregations for the member progress
// dashboard. No IO. champ-app-only (like goals.js). Every day, week and month
// bucket is on the MEMBER's calendar: `zone` is their home studio's (TZ.13 /
// TZ.17, D7; omitted = Europe/Dublin). Weeks and months were UTC until TZ.17,
// so a session at 00:30 Dublin summer time on a Monday (or the 1st) landed in
// the previous week (or month) while the streak beside it counted it today.
//
// A week's `weekStartMs` is a CALENDAR anchor, not an instant: 00:00 UTC on the
// date of the local Monday (render it with timeZone 'UTC', as the screens do).
// Weeks step in whole UTC days from it, which no clock change can bend.
import { currentStreak } from './hr-analytics.js'
import { dateKeyIn, dayStartMsIn, addDaysIn, DEFAULT_TZ } from './zoned-time.js'

const DAY = 24 * 3600 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function startedMs(s) { const t = Date.parse(s?.started_at); return Number.isFinite(t) ? t : null }
function minutesOf(s) {
  const a = Date.parse(s?.started_at), b = Date.parse(s?.ended_at)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  const m = (b - a) / 60000
  return m > 0 ? m : 0
}
function pointsOf(s) { return Number.isFinite(s?.effort_points) ? s.effort_points : 0 }
// 00:00 UTC on the instant's LOCAL calendar date in `zone` (a date anchor).
function localDayAnchor(ms, zone) { const [y, m, d] = dateKeyIn(ms, zone).split('-').map(Number); return Date.UTC(y, m - 1, d) }
// The anchor of the local Monday of the instant's week.
function weekAnchor(ms, zone) { const day = localDayAnchor(ms, zone); const dow = (new Date(day).getUTCDay() + 6) % 7; return day - dow * DAY } // Monday
function weekLabel(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }
function monthLabel(y, m) { return `${MONTHS[m]} ${y}` }

export function weeklyBuckets(sessions, nowMs = Date.now(), weeks = 12, zone = DEFAULT_TZ) {
  const thisWeek = weekAnchor(nowMs, zone)
  const startWeek = thisWeek - (weeks - 1) * 7 * DAY
  const buckets = []
  for (let i = 0; i < weeks; i++) {
    const weekStartMs = startWeek + i * 7 * DAY
    buckets.push({ weekStartMs, label: weekLabel(weekStartMs), count: 0, points: 0, minutes: 0, _ps: 0, _pn: 0 })
  }
  for (const s of sessions || []) {
    const t = startedMs(s); if (t === null || t >= nowMs) continue
    const ws = weekAnchor(t, zone)
    if (ws < startWeek || ws > thisWeek) continue
    const b = buckets[Math.round((ws - startWeek) / (7 * DAY))]; if (!b) continue
    b.count++; b.points += pointsOf(s); b.minutes += minutesOf(s)
    if (Number.isFinite(s?.peak_hr_bpm)) { b._ps += s.peak_hr_bpm; b._pn++ }
  }
  return buckets.map(b => ({
    weekStartMs: b.weekStartMs, label: b.label, count: b.count,
    points: Math.round(b.points), minutes: Math.round(b.minutes),
    avgPeakHr: b._pn ? Math.round(b._ps / b._pn) : null,
  }))
}

export function monthlyRecap(sessions, nowMs = Date.now(), months = 6, zone = DEFAULT_TZ) {
  const byMonth = new Map()
  for (const s of sessions || []) {
    const t = startedMs(s); if (t === null || t >= nowMs) continue
    const d = new Date(localDayAnchor(t, zone)), y = d.getUTCFullYear(), m = d.getUTCMonth(), key = `${y}-${m}`
    let a = byMonth.get(key)
    if (!a) { a = { year: y, month: m, count: 0, points: 0, minutes: 0, _ps: 0, _pn: 0 }; byMonth.set(key, a) }
    a.count++; a.points += pointsOf(s); a.minutes += minutesOf(s)
    if (Number.isFinite(s?.peak_hr_bpm)) { a._ps += s.peak_hr_bpm; a._pn++ }
  }
  let fittest = null
  for (const a of byMonth.values()) {
    if (a.points > 0 && (!fittest || a.points > fittest.points)) fittest = { year: a.year, month: a.month, points: Math.round(a.points) }
  }
  const now = new Date(localDayAnchor(nowMs, zone)), out = []
  for (let i = months - 1; i >= 0; i--) {
    const dd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const a = byMonth.get(`${dd.getUTCFullYear()}-${dd.getUTCMonth()}`)
    out.push({
      year: dd.getUTCFullYear(), month: dd.getUTCMonth(), label: monthLabel(dd.getUTCFullYear(), dd.getUTCMonth()),
      count: a?.count || 0, points: Math.round(a?.points || 0), minutes: Math.round(a?.minutes || 0),
      avgPeakHr: a && a._pn ? Math.round(a._ps / a._pn) : null,
    })
  }
  return { months: out, fittest }
}

// `zone` (TZ.13/TZ.17, D7): the member's home studio zone, for the day-streak
// and the best-week bucket (a local Monday-to-Sunday week).
export function personalRecords(sessions, zone = DEFAULT_TZ) {
  const list = (sessions || []).filter(s => startedMs(s) !== null)
  let bestSessionPoints = null, highestPeakHr = null, longestSessionMin = null
  const weekPoints = new Map()
  for (const s of list) {
    const t = startedMs(s), p = pointsOf(s)
    if (p > 0 && (!bestSessionPoints || p > bestSessionPoints.value)) bestSessionPoints = { value: p, sessionId: s.id, atMs: t }
    if (Number.isFinite(s?.peak_hr_bpm) && (!highestPeakHr || s.peak_hr_bpm > highestPeakHr.value)) highestPeakHr = { value: s.peak_hr_bpm, sessionId: s.id, atMs: t }
    const mins = minutesOf(s)
    if (mins > 0 && (!longestSessionMin || mins > longestSessionMin.value)) longestSessionMin = { value: Math.round(mins), sessionId: s.id, atMs: t }
    const ws = weekAnchor(t, zone); weekPoints.set(ws, (weekPoints.get(ws) || 0) + p)
  }
  let bestWeekPoints = null
  for (const [ws, pts] of weekPoints) {
    if (pts > 0 && (!bestWeekPoints || pts > bestWeekPoints.value)) bestWeekPoints = { value: Math.round(pts), weekStartMs: ws }
  }
  return { bestSessionPoints, highestPeakHr, longestSessionMin, bestWeekPoints, bestStreak: currentStreak(list, Date.now(), zone).best }
}

// Day-buckets in `zone` — the member's home studio zone (TZ.13, D7; omitted =
// Europe/Dublin), NOT UTC — so the heatmap agrees with the locally-keyed streak
// + milestone numbers shown beside it: a summer-time session at 00:00–01:00
// Dublin must light today's cell, not yesterday's. Days are walked via
// addDaysIn (not a fixed 24h step) so the grid never drifts across a clock
// change. `dayMs` is the local-midnight instant of each cell.
export function activityCalendar(sessions, nowMs = Date.now(), days = 84, zone = DEFAULT_TZ) {
  const todayKey = dateKeyIn(nowMs, zone)
  const startKey = addDaysIn(todayKey, -(days - 1), zone)
  const map = new Map()
  for (const s of sessions || []) {
    const t = startedMs(s); if (t === null || t >= nowMs) continue
    const key = dateKeyIn(t, zone)
    if (key < startKey || key > todayKey) continue // 'YYYY-MM-DD' sorts lexically
    const a = map.get(key) || { count: 0, points: 0 }; a.count++; a.points += pointsOf(s); map.set(key, a)
  }
  const out = []; let maxCount = 0
  let key = startKey
  for (let i = 0; i < days; i++) {
    const a = map.get(key) || { count: 0, points: 0 }
    if (a.count > maxCount) maxCount = a.count
    out.push({ dayMs: dayStartMsIn(key, zone), dateKey: key, count: a.count, points: Math.round(a.points) })
    key = addDaysIn(key, 1, zone)
  }
  return { days: out, maxCount }
}
