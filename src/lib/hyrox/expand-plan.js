// HYROX-TC.3 — pure: which weeks the rolling-expansion cron should fill. No IO.
import { daysBetween } from './mapping'

export function currentWeekNo(startsOn, nowYmd) {
  const diff = daysBetween(startsOn, nowYmd)
  if (!Number.isFinite(diff) || diff < 0) return null
  return Math.floor(diff / 7) + 1
}

// current..current+aheadWeeks (clamped to block.weeks) that have zero sessions yet.
export function weeksNeedingExpansion(block, existingWeekNos, nowYmd, aheadWeeks = 2) {
  const cur = currentWeekNo(block.starts_on, nowYmd)
  if (cur == null) return []
  const have = new Set(existingWeekNos)
  const out = []
  for (let w = cur; w <= Math.min(cur + aheadWeeks, block.weeks); w++) {
    if (w >= 1 && !have.has(w)) out.push(w)
  }
  return out
}
