// KEEP IN SYNC with un1t-crm/src/lib/tiers.js (verbatim copy below line 1).
// Status-tier ladder. Pure — months-hit count in, tier out.
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
