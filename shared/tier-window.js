// Tier decay (approved decision #4) — the ROLLING-WINDOW count of months a
// member hit their monthly target. Pure + Europe/Dublin-correct.
//
// Why this lives in its own module (not tiers.js): `shared/tiers.js` is a
// verbatim cross-repo copy of un1t-crm/src/lib/tiers.js (the ladder + the
// count→tier functions) and must stay byte-identical. Decay adds a
// Dublin-time dependency (month keys), so it lives here instead of coupling
// the shared ladder to dublin-time.js. `tierForMonths` / `nextTier` still take
// a plain count — this module only decides WHICH count to feed them.
//
// SHARED CONTRACT (mirrored by the un1t-crm operator-config agent):
//   config path : location.settings.scoring.tier_window_months
//   value       : integer N >= 1  → rolling window of N calendar months
//                 absent / null   → NO DECAY (cumulative behaviour, today)
//   windowed count = number of DISTINCT Europe/Dublin calendar months the
//   member hit target within [startOfMonth(now) − (N−1) months .. now],
//   inclusive of the current month.
//
// DEFAULT-OFF: when windowMonths is absent/null, resolveTierMonths returns the
// cumulative count unchanged → identical output to the pre-decay path.

import { dublinMonthKey } from './dublin-time.js'

/**
 * The set of Europe/Dublin month keys ('YYYY-MM') that fall inside the rolling
 * window of `windowMonths` months ending at (and including) the Dublin month of
 * `nowMs`. Pure string arithmetic on year/month — DST-agnostic (a month key has
 * no clock component).
 *
 * @param {number} windowMonths  positive integer N
 * @param {number} nowMs         UTC ms "now"
 * @returns {Set<string>}        N keys, e.g. {'2026-01', ..., '2026-06'}
 */
export function windowMonthKeys(windowMonths, nowMs = Date.now()) {
  const n = Math.trunc(Number(windowMonths))
  if (!Number.isFinite(n) || n < 1) return new Set()
  const nowKey = dublinMonthKey(nowMs)
  let [y, m] = nowKey.split('-').map(Number) // m is 1..12
  const keys = new Set()
  for (let i = 0; i < n; i++) {
    keys.add(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return keys
}

/**
 * Count how many of a member's hit-month keys fall inside the rolling window.
 * Distinct by construction (the window is a Set and we count each window key at
 * most once, so duplicate input keys collapse).
 *
 * @param {Iterable<string>} hitMonthKeys  'YYYY-MM' keys the member hit target
 * @param {number} windowMonths            positive integer N
 * @param {number} [nowMs=Date.now()]      UTC ms "now"
 * @returns {number}                       count in [0, windowMonths]
 */
export function monthsHitInWindow(hitMonthKeys, windowMonths, nowMs = Date.now()) {
  const win = windowMonthKeys(windowMonths, nowMs)
  if (win.size === 0) return 0
  const hit = new Set()
  for (const k of hitMonthKeys || []) {
    if (win.has(k)) hit.add(k)
  }
  return hit.size
}

/**
 * Decide the count to feed tierForMonths / nextTier.
 *
 * - windowMonths a positive integer  → windowed (decaying) count from history.
 * - windowMonths absent / null / <1  → cumulative count unchanged (default-off,
 *   byte-identical to the pre-decay behaviour).
 *
 * @param {object}   args
 * @param {Iterable<string>} [args.hitMonthKeys]     'YYYY-MM' keys hit (for windowed path)
 * @param {number}   args.cumulativeMonths           the existing total months-hit count
 * @param {number|null|undefined} args.windowMonths  location.settings.scoring.tier_window_months
 * @param {number}   [args.nowMs=Date.now()]
 * @returns {number} the resolved months-hit count
 */
export function resolveTierMonths({ hitMonthKeys, cumulativeMonths, windowMonths, nowMs = Date.now() } = {}) {
  const n = Math.trunc(Number(windowMonths))
  const cumulative = Math.max(0, Math.trunc(Number(cumulativeMonths) || 0))
  if (!Number.isFinite(n) || n < 1) return cumulative // decay off → today's behaviour
  return monthsHitInWindow(hitMonthKeys, n, nowMs)
}
