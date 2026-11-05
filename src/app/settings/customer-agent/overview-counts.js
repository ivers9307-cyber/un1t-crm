// MIASETTINGS.2e — how many settings this studio has changed from its
// organisation's, per section, for the Overview summary.

import { sectionForPath } from './sections'

/**
 * Count the studio's override paths per section. The quiet hours window
 * (start, end, off, tz) counts once, as one Overview setting. Paths that
 * belong to no section are not counted.
 * @param {string[]} overridden
 * @returns {Record<string, number>} only sections with at least one setting
 */
export function overrideCountsBySection(overridden) {
  const counts = {}
  let quietSeen = false
  for (const path of overridden || []) {
    if (path === 'quiet_hours' || path.startsWith('quiet_hours.')) {
      if (quietSeen) continue
      quietSeen = true
    }
    const section = sectionForPath(path)
    if (!section) continue
    counts[section] = (counts[section] || 0) + 1
  }
  return counts
}
