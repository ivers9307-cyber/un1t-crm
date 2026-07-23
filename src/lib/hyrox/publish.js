// HYROX-TC.3 — pure decisions for the publish cron. No IO.
import { weekNoFor, slotFor } from './mapping'

// The approved/published session that a live HYROX occurrence maps to, or null.
export function pickSessionForOccurrence(block, sessions, occurrenceIso) {
  const wk = weekNoFor(block.starts_on, occurrenceIso, block.weeks)
  if (wk == null) return null
  const slot = slotFor(block.session_weekdays, occurrenceIso)
  if (slot == null) return null
  return (sessions || []).find(
    (s) => s.week_no === wk && s.slot === slot && (s.status === 'approved' || s.status === 'published'),
  ) || null
}

// Which of a location's active TV displays should show the Hyrox board.
// Operator can restrict via locations.settings.hyrox.tv_display_ids; unset/empty = all active.
export function resolveHyroxDisplayIds(loc, activeDisplayIds) {
  const ids = loc?.settings?.hyrox?.tv_display_ids
  if (Array.isArray(ids) && ids.length) return activeDisplayIds.filter((id) => ids.includes(id))
  return activeDisplayIds
}
