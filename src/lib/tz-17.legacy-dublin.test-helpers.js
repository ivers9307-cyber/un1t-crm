// TZ.17 — FROZEN copies of the date logic this task corrected, copied from
// origin/main 786d764e. Bodies are unchanged except that a host-clock read is
// kept as the host clock (the tests pin process.env.TZ = 'UTC', which is what
// Vercel runs), the exported names gain a `Legacy` suffix, and a function that
// was inline in a route or a component is lifted out as written. Private helpers
// travel with them. src/lib/tz-17*.test.js diff the new code against these.
// Test-only: nothing in src/ imports this file. TZ.18b deletes it once the wave
// merges.
/* eslint-disable guardrails/no-utc-today, guardrails/no-zulu-template-date -- frozen pre-TZ.17 copies, kept to prove the fix */

import { currentStreak } from '@shared/hr-analytics'
import { dayStartMsIn, instantToZonedParts, todayStrIn, DEFAULT_TZ } from '@shared/zoned-time'

// ── src/lib/whatsapp-flow/handler.js:58,72 — the Flow's class day ────────────
export const flowClassDayLegacy = (c) => c.starts_at.slice(0, 10)

// ── src/lib/sequences/cron-triggers.js:105-127 — event_reminder window ───────
export function eventReminderLegacy(nowMs, hoursBefore, booking, toleranceMs = 60 * 60 * 1000) {
  const targetMs = nowMs + hoursBefore * 3600_000
  const lo = new Date(targetMs - toleranceMs)
  const hi = new Date(targetMs + toleranceMs)
  const loDay = lo.toISOString().slice(0, 10)
  const hiDay = hi.toISOString().slice(0, 10)
  const bookingMs = new Date(`${booking.booking_date}T${booking.start_time}Z`).getTime()
  const inDays = booking.booking_date >= loDay && booking.booking_date <= hiDay
  return { loDay, hiDay, matches: inDays && !(bookingMs < lo.getTime() || bookingMs > hi.getTime()) }
}

// ── src/lib/today-feed-data.js:43 — host-local "today" ───────────────────────
export function isoTodayLegacy(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── src/components/ConsultationForm.jsx:28 ───────────────────────────────────
export function toDateInputLegacy(iso, zone) {
  if (!iso) return todayStrIn(zone)
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return todayStrIn(zone)
  return d.toISOString().slice(0, 10)
}

// ── src/lib/agent/approval-suggest.js:131 — the prompt's "today" ─────────────
export const approvalTodayLegacy = (nowMs) => new Date(nowMs).toDateString()

// ── src/lib/goals.js — UTC weeks and months ──────────────────────────────────
export function startOfIsoWeekLegacy(now = new Date()) {
  const d = new Date(now)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - day)
  return d
}
export function startOfMonthLegacy(now = new Date()) {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
const GOAL_PERIOD = { weekly_points: ['week', 'effort_points'], weekly_classes: ['week', 'classes'], monthly_points: ['month', 'effort_points'], monthly_classes: ['month', 'classes'] }
export function computeProgressCurrentLegacy(goal, sessions, now = new Date()) {
  const [period, field] = GOAL_PERIOD[goal.kind]
  const periodStart = period === 'week' ? startOfIsoWeekLegacy(now) : startOfMonthLegacy(now)
  const startMs = periodStart.getTime()
  let current = 0
  for (const s of sessions || []) {
    const t = new Date(s.started_at || s.ended_at).getTime()
    if (t < startMs) continue
    if (field === 'classes') current += 1
    else if (field === 'effort_points') current += Number(s.effort_points) || 0
  }
  return { current, periodStartMs: startMs }
}

// ── src/lib/live-class.js:705 — the target-hit push's month name ─────────────
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const liveClassMonthLabelLegacy = (nowMs) => MONTH_NAMES[new Date(nowMs).getUTCMonth()]

// ── shared/progress-analytics.js — UTC weeks and months ──────────────────────
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
function utcDayStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) }
function utcWeekStart(ms) { const day = utcDayStart(ms); const dow = (new Date(day).getUTCDay() + 6) % 7; return day - dow * DAY } // Monday
function weekLabel(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }
function monthLabel(y, m) { return `${MONTHS[m]} ${y}` }

export function weeklyBucketsLegacy(sessions, nowMs = Date.now(), weeks = 12) {
  const thisWeek = utcWeekStart(nowMs)
  const startWeek = thisWeek - (weeks - 1) * 7 * DAY
  const buckets = []
  for (let i = 0; i < weeks; i++) {
    const weekStartMs = startWeek + i * 7 * DAY
    buckets.push({ weekStartMs, label: weekLabel(weekStartMs), count: 0, points: 0, minutes: 0, _ps: 0, _pn: 0 })
  }
  for (const s of sessions || []) {
    const t = startedMs(s); if (t === null || t >= nowMs) continue
    const ws = utcWeekStart(t)
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

export function monthlyRecapLegacy(sessions, nowMs = Date.now(), months = 6) {
  const byMonth = new Map()
  for (const s of sessions || []) {
    const t = startedMs(s); if (t === null || t >= nowMs) continue
    const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth(), key = `${y}-${m}`
    let a = byMonth.get(key)
    if (!a) { a = { year: y, month: m, count: 0, points: 0, minutes: 0, _ps: 0, _pn: 0 }; byMonth.set(key, a) }
    a.count++; a.points += pointsOf(s); a.minutes += minutesOf(s)
    if (Number.isFinite(s?.peak_hr_bpm)) { a._ps += s.peak_hr_bpm; a._pn++ }
  }
  let fittest = null
  for (const a of byMonth.values()) {
    if (a.points > 0 && (!fittest || a.points > fittest.points)) fittest = { year: a.year, month: a.month, points: Math.round(a.points) }
  }
  const now = new Date(nowMs), out = []
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

export function personalRecordsLegacy(sessions, zone = DEFAULT_TZ) {
  const list = (sessions || []).filter(s => startedMs(s) !== null)
  let bestSessionPoints = null, highestPeakHr = null, longestSessionMin = null
  const weekPoints = new Map()
  for (const s of list) {
    const t = startedMs(s), p = pointsOf(s)
    if (p > 0 && (!bestSessionPoints || p > bestSessionPoints.value)) bestSessionPoints = { value: p, sessionId: s.id, atMs: t }
    if (Number.isFinite(s?.peak_hr_bpm) && (!highestPeakHr || s.peak_hr_bpm > highestPeakHr.value)) highestPeakHr = { value: s.peak_hr_bpm, sessionId: s.id, atMs: t }
    const mins = minutesOf(s)
    if (mins > 0 && (!longestSessionMin || mins > longestSessionMin.value)) longestSessionMin = { value: Math.round(mins), sessionId: s.id, atMs: t }
    const ws = utcWeekStart(t); weekPoints.set(ws, (weekPoints.get(ws) || 0) + p)
  }
  let bestWeekPoints = null
  for (const [ws, pts] of weekPoints) {
    if (pts > 0 && (!bestWeekPoints || pts > bestWeekPoints.value)) bestWeekPoints = { value: Math.round(pts), weekStartMs: ws }
  }
  return { bestSessionPoints, highestPeakHr, longestSessionMin, bestWeekPoints, bestStreak: currentStreak(list, Date.now(), zone).best }
}

// ── src/lib/manual-timetable.js:194 — the one-pass solver ────────────────────
export function zonedWallClockMsOnePassLegacy(dateKey, time, zone) {
  const [h, mi] = time.split(':').map(Number)
  const wanted = h * 60 + mi
  const guess = dayStartMsIn(dateKey, zone) + wanted * 60_000
  const landed = instantToZonedParts(guess, zone)
  return guess + (wanted - landed.minuteOfDay) * 60_000
}

// ── src/lib/ads/read.js:80-84 + ads/attribution.js:33 — booked-request window ─
export function adsCreatedAtInWindowLegacy(createdAt, since, until) {
  return createdAt >= since && createdAt <= until + 'T23:59:59'
}
export const adsTrendDayLegacy = (createdAt) => String(createdAt).slice(0, 10)

// ── src/lib/postmark.js:539 — {{current_year}} ───────────────────────────────
export const currentYearLegacy = () => new Date().getFullYear().toString()

// ── src/lib/cars.js:302-405 — the date parts of computeReportMetrics ─────────
export function carsPeriodsLegacy(nowInput) {
  const now = new Date(nowInput)
  const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const months = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const startIso = d.toISOString()
    const endIso = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString()
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }),
      startIso, endIso,
    })
  }
  return { startOfYear, startOfMonth, months }
}

// ── src/app/api/cars/reports/export/route.js:63 ──────────────────────────────
export const carsExportYearStartLegacy = (nowMs) => new Date(new Date(nowMs).getFullYear(), 0, 1).toISOString()

// ── src/app/api/cars/[id]/issue-deposit-link/route.js:134 ────────────────────
export const depositExpiryLabelLegacy = (expiresAt) => new Date(expiresAt).toLocaleString('en-IE')

// ── src/lib/external-export.js:257 — the Strava title's date ─────────────────
export const stravaTitleDateLegacy = (startedAt) => new Date(startedAt).toLocaleDateString('en-IE')

// ── src/app/api/cron/notify-streak-at-risk/route.js:64-77 — legacy (Dublin) slot
export function streakWindowLegacy(slotDay) {
  return {
    todayMs: dayStartMsIn(slotDay, 'UTC'),
    yestMs: dayStartMsIn(new Date(Date.parse(`${slotDay}T12:00:00Z`) - DAY).toISOString().slice(0, 10), 'UTC'),
    dedupKey: slotDay,
  }
}

// ── src/app/api/public/tv-challenges/[token]/route.js:98-99 ──────────────────
export function tvGymMonthFromLegacy(nowMs) {
  const d = new Date(nowMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

// ── mobile/app/(member)/(tabs)/home.jsx:533 — the challenge countdown ────────
export function daysUntilLegacy(isoDate, nowMs) {
  if (!isoDate) return null
  // isoDate is a plain 'YYYY-MM-DD'; compare at UTC midnight to avoid tz drift.
  const t = Date.parse(`${isoDate}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.round((t - today) / (24 * 3600 * 1000))
}
