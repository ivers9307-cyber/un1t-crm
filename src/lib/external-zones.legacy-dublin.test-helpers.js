// TZ.11c — FROZEN copies of the date logic this task made zone-aware, copied
// from origin/main 19e8617a. Bodies are unchanged except that exported names
// gain a `Legacy` suffix and whole-line comments are dropped. Everything here
// reads Date.now(), as the originals did, so the tests drive it with fake
// timers. src/lib/external-zones.tz.test.js diffs the new code against these.
// Test-only: nothing in src/ imports this file. TZ.18b deletes it once the
// timezone wave has merged.
import { dublinTodayStr, addDaysISO } from '@/lib/dublin-time'
import { dublinDateKey, dublinAddDays, DUBLIN_DAY_MS } from '@shared/dublin-time'

// ── src/lib/ads/read.js, src/app/api/cron/ad-insights-sync/route.js,
//    src/app/api/cron/ad-insights-backfill/route.js,
//    src/app/api/dashboard/ads/refresh/route.js (four identical copies) ──────
export function dublinDateStrLegacy(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(d) // YYYY-MM-DD
}

// ── shared/dashboard-data.js fetchAdsSummary: the two window bounds ────────
export function adsSummaryWindowLegacy(now = new Date()) {
  const nowMs = now.getTime()
  const sinceIso = dublinAddDays(dublinDateKey(nowMs), -7)
  const attributedSinceIso = new Date(nowMs - 7 * DUBLIN_DAY_MS).toISOString()
  return { sinceIso, attributedSinceIso }
}

// ── src/app/api/accounting/payables/route.js: the ageing day and asOf ──────
export function payablesDaysLegacy() {
  return { agedOn: dublinTodayStr(), asOf: dublinTodayStr() }
}

// ── src/lib/recon/pull.js: the Xero window floor (no tracked lines) and toDate
const DEFAULT_WINDOW_DAYS = 90
export function reconPullWindowLegacy() {
  const floor = addDaysISO(dublinTodayStr(), -DEFAULT_WINDOW_DAYS)
  const windowTo = dublinTodayStr()
  return { windowFrom: floor, windowTo }
}

// ── src/lib/recon/finalize.js: the coverage report's date label ────────────
export function coverageReportDateLegacy() {
  return dublinTodayStr()
}
