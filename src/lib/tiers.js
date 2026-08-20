// Status-tier ladder. Pure — months-hit count in, tier out.
// un1t-crm uses it for the tier-up push (name+colour); champ-app for the dashboard badge.
//
// SYNC RULE (corrected by PAIRSYNC.1 — line 1 used to say "verbatim copy
// below line 1", and it had NOT been one since the windowed-decay helpers
// landed): shared/tiers.js is the SUBSET. Everything down to `nextTier` must
// stay byte-identical with shared/tiers.js and champ-app/shared/tiers.js —
// the ladder is what decides which badge a member sees, on three surfaces.
// The rolling-window decay block BELOW it is un1t-crm-only, because only the
// CRM reads `location.settings.scoring.tier_window_months`.
//
// Enforced by tests/shared-pair-sync.test.js (mode 'web-superset'): every
// export shared declares must be byte-equal here, TIERS must deep-equal, and
// tierForMonths/nextTier must agree across the whole ladder. Adding another
// web-only export means declaring it in that manifest.
export const TIERS = [
  { slug: 'bronze',   name: 'Bronze',   months: 1,  color: '#c77b3a' },
  { slug: 'silver',   name: 'Silver',   months: 3,  color: '#c2c8ce' },
  { slug: 'gold',     name: 'Gold',     months: 6,  color: '#e8b931' },
  { slug: 'platinum', name: 'Platinum', months: 12, color: '#cfe2ea' },
  { slug: 'elite',    name: 'Elite',    months: 24, color: '#ff5a1f' },
]

/** Highest tier whose `months` threshold is <= monthsHit; null below Bronze (0). */
export function tierForMonths(monthsHit) {
  const n = Number(monthsHit) || 0
  let out = null
  for (const t of TIERS) { if (n >= t.months) out = t; else break }
  return out
}

/** The next rung above monthsHit, or null at the top (Elite). */
export function nextTier(monthsHit) {
  const n = Number(monthsHit) || 0
  for (const t of TIERS) { if (n < t.months) return t }
  return null
}

// --- Tier decay (rolling window) -------------------------------------------
// Config lives at location.settings.scoring.tier_window_months: an integer
// N >= 1 = count only the months hit within the last N calendar months
// (inclusive of the current month); absent/null/0 = NO DECAY, i.e. the
// cumulative all-time count (unchanged behaviour). Default-off: with no N
// set, every member keeps exactly today's tier.
//
// Months are counted over 'YYYY-MM' period keys, which are discrete and
// lexicographically ordered, so windowing is pure string arithmetic — no DST
// or day-boundary hazard. The ONLY timezone-sensitive step is deciding which
// month "now" is (near a midnight month-boundary during BST); callers pass a
// Dublin-derived nowMonth for that. KEEP IN SYNC with champ-app/shared/tiers.js.

/** Coerce settings.scoring.tier_window_months to a positive int, else null (no decay). */
export function tierWindowMonths(location) {
  const raw = location?.settings?.scoring?.tier_window_months
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

/** Shift a 'YYYY-MM' key by `delta` months (delta may be negative). */
export function shiftMonthKey(monthKey, delta) {
  const [y, m] = String(monthKey).split('-').map(Number)
  // month index 0-based for arithmetic, then back to 1-based
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = (total % 12 + 12) % 12
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}`
}

/**
 * Distinct months a member banked, applying the rolling window if set.
 * @param periodMonths  array of banked 'YYYY-MM' keys (dupes tolerated)
 * @param windowMonths  N >= 1 (rolling window) or null/absent (cumulative)
 * @param nowMonth      current 'YYYY-MM' in the member's (Dublin) calendar —
 *                      only used when windowMonths is set.
 * @returns count of distinct qualifying months.
 */
export function windowedMonthsHit(periodMonths, windowMonths, nowMonth) {
  const distinct = new Set()
  for (const p of periodMonths || []) {
    if (typeof p === 'string' && /^\d{4}-\d{2}$/.test(p)) distinct.add(p)
  }
  const n = Number(windowMonths)
  if (!Number.isInteger(n) || n < 1) return distinct.size // no decay: cumulative
  // Window is the N months ending at nowMonth inclusive: [floor, nowMonth].
  const floor = shiftMonthKey(nowMonth, -(n - 1))
  let count = 0
  for (const p of distinct) {
    if (p >= floor && p <= nowMonth) count++
  }
  return count
}
