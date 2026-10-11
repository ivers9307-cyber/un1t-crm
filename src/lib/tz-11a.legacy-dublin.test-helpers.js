// TZ.11a — FROZEN copies of the report / dashboard / snapshot functions this
// task made zone-aware, copied from origin/main 19e8617a. Bodies are unchanged
// except: exported names gain a `Legacy` suffix, whole-line comments are
// dropped, a private helper is exported, and an implicit `Date.now()`/`new
// Date()` became a `nowMs` argument (its only clock input) so it can be
// sampled. The *.tz*.test.js files of TZ.11a diff the new code against these.
// Test-only: nothing in src/ imports this file. TZ.18b deletes it once the
// timezone wave has merged.
import { formatDate } from '@/lib/roster'
import { dublinDayStr, dublinDayRangeMs, addDaysISO, dublinDateKey, dublinMonthStartMs, dublinWeekStartMs, dublinAddDays } from '@/lib/dublin-time'
import { paginatedSumCents } from '@shared/dashboard-data'
import { pctDelta, shapeFunnel, FUNNEL_SLUGS } from '@shared/dashboard-metrics'

// ── src/lib/report-generator.js (host-local: UTC on Vercel) ────────────────
export function calculatePeriodForScheduleLegacy(frequency, nowMs) {
  const now = new Date(nowMs)

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  if (frequency === 'daily') {
    const day = formatDate(yesterday)
    return { period_start: day, period_end: day }
  }

  if (frequency === 'monthly') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0)
    return { period_start: formatDate(first), period_end: formatDate(last) }
  }

  const span = frequency === 'fortnightly' ? 13 : 6
  const start = new Date(yesterday)
  start.setDate(start.getDate() - span)
  return { period_start: formatDate(start), period_end: formatDate(yesterday) }
}

export function calculateNextRunLegacy(frequency, dayOfWeek, dayOfMonth, nowMs) {
  const now = new Date(nowMs)

  if (frequency === 'daily') {
    const target = new Date(now)
    target.setDate(target.getDate() + 1)
    target.setHours(7, 0, 0, 0)
    return target.toISOString()
  }

  if ((frequency === 'weekly' || frequency === 'fortnightly') && dayOfWeek != null) {
    const target = new Date(now)
    const diff = (dayOfWeek - target.getDay() + 7) % 7
    const next = diff === 0 ? 7 : diff
    target.setDate(target.getDate() + next + (frequency === 'fortnightly' ? 7 : 0))
    target.setHours(7, 0, 0, 0)
    return target.toISOString()
  }

  if (frequency === 'monthly') {
    const requested = Number(dayOfMonth) > 0 ? Math.floor(Number(dayOfMonth)) : 1
    const lastDayOfTargetMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate()
    const day = Math.min(requested, lastDayOfTargetMonth)
    const target = new Date(now.getFullYear(), now.getMonth() + 1, day, 7, 0, 0)
    return target.toISOString()
  }

  return null
}

// ── src/lib/membership-snapshot.js ─────────────────────────────────────────
// writeMembershipSnapshot's key (its only zone-dependent line).
export function snapshotDateLegacy(opts = {}) {
  return opts.snapshotDate || dublinDayStr(opts.now ? new Date(opts.now) : Date.now())
}
export function monthsAgoFirstLegacy(months, todayStr = dublinDayStr(Date.now())) {
  const y = Number(todayStr.slice(0, 4))
  const m = Number(todayStr.slice(5, 7))
  const total = y * 12 + (m - 1) - months
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

// ── src/lib/membership-flows.js (the month keys; monthKeys is unchanged) ───
export function flowsTodayLegacy(nowMs) {
  return dublinDayStr(nowMs)
}
export function flowsMonthOfLegacy(instant) {
  return dublinDayStr(instant).slice(0, 7)
}

// ── src/lib/labour-month-model.js ──────────────────────────────────────────
export function labourMonthWindowLegacy(nowMs) {
  const today = dublinDayStr(nowMs)
  const month = today.slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const startDate = `${month}-01`
  const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`
  const { startMs, endMs } = dublinDayRangeMs(startDate, endDate)
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
  const monthLabel = new Intl.DateTimeFormat('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)))
  return {
    month, monthLabel, startDate, endDate, startMs, endMs,
    daysInMonth, dayOfMonth: Number(today.slice(8, 10)), elapsedFraction,
  }
}

// ── src/lib/account-home.js ────────────────────────────────────────────────
export function dublinWeekWindowLegacy(now = Date.now()) {
  const end = dublinDayStr(now)
  const start = addDaysISO(end, -6)
  return { start, end }
}
// countOpenApprovals' time-off floor.
export function openApprovalsFloorLegacy(nowMs) {
  return dublinDayStr(nowMs)
}

// ── src/app/api/dashboard/studio-contacts/route.js ─────────────────────────
export function studioContactsWeekStartIsoLegacy(nowMs) {
  return new Date(dublinWeekStartMs(nowMs)).toISOString()
}

// ── src/lib/today-feed-data.js (low-fill label) ────────────────────────────
export function lowFillTimeLabelLegacy(timeStartMs) {
  return new Date(timeStartMs).toLocaleTimeString('en-IE', {
    timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
  })
}

// ── shared/dashboard-data.js ───────────────────────────────────────────────
export async function fetchRevenueMTDLegacy(supabase, locationId, now = new Date()) {
  const nowMs = now.getTime()
  const [y, m, d] = dublinDateKey(nowMs).split('-').map(Number)
  const monthStartIso = new Date(dublinMonthStartMs(nowMs)).toISOString()
  const prevY = m === 1 ? y - 1 : y
  const prevM = m === 1 ? 12 : m - 1
  const daysInPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate()
  const pad = (n) => String(n).padStart(2, '0')
  const prevRange = dublinDayRangeMs(
    `${prevY}-${pad(prevM)}-01`,
    `${prevY}-${pad(prevM)}-${pad(Math.min(d, daysInPrev))}`,
  )
  const prevStartIso = new Date(prevRange.startMs).toISOString()
  const prevEndIso = new Date(prevRange.endMs).toISOString()

  const cur = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', monthStartIso))
  if (cur.error) return { success: false, error: cur.error.message }

  const prev = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', prevStartIso)
    .lt('invoice_date', prevEndIso))
  if (prev.error) return { success: false, error: prev.error.message }

  return {
    success: true,
    data: {
      totalCents: cur.totalCents,
      paidCount: cur.rows,
      deltaPct: pctDelta(cur.totalCents, prev.totalCents),
    },
  }
}

export async function fetchFunnelCountsLegacy(supabase, locationId, now = new Date()) {
  const monthStartIso = new Date(dublinMonthStartMs(now.getTime())).toISOString()

  const results = await Promise.all([
    ...FUNNEL_SLUGS.map(slug => supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).eq('pipeline_stage_slug', slug)),
    supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).gte('joined_at', monthStartIso),
    supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).gte('converted_at', monthStartIso),
  ])

  const stageCounts = {}
  for (let i = 0; i < FUNNEL_SLUGS.length; i++) {
    const { count, error } = results[i]
    if (error) return { success: false, error: error.message }
    stageCounts[FUNNEL_SLUGS[i]] = count || 0
  }
  const { count: entered, error: e1 } = results[FUNNEL_SLUGS.length]
  if (e1) return { success: false, error: e1.message }
  const { count: converted, error: e2 } = results[FUNNEL_SLUGS.length + 1]
  if (e2) return { success: false, error: e2.message }
  return { success: true, data: shapeFunnel(stageCounts, { entered: entered || 0, converted: converted || 0 }) }
}

// fetchTodayOps' window (the queries and the folding below it are unchanged).
export function todayOpsWindowLegacy(nowMs) {
  const todayIso = dublinDateKey(nowMs)
  const { startMs: dayStartMs, endMs: dayEndMs } = dublinDayRangeMs(todayIso, todayIso)
  const weekStartIso = dublinDateKey(dublinWeekStartMs(nowMs))
  const weekEndIso = dublinAddDays(weekStartIso, 6)
  return { todayIso, dayStartMs, dayEndMs, weekStartIso, weekEndIso }
}
