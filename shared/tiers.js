// Status-tier ladder. Pure — months-hit count in, tier out.
// SYNC RULE (corrected by PAIRSYNC.1): this file is the SUBSET of
// un1t-crm/src/lib/tiers.js — everything here must stay byte-identical there,
// but that copy also carries a rolling-window decay block this one does not
// (only the CRM reads location.settings.scoring.tier_window_months). Line 1
// used to claim a "verbatim copy" in both directions and had been wrong since
// those helpers landed. Enforced by tests/shared-pair-sync.test.js.
// un1t-crm uses it for the tier-up push (name+colour); champ-app for the dashboard badge.
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
