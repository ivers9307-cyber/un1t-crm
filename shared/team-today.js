// Group a flat list of team shift rows (from GET /api/schedule/shifts) by coach
// for the "On with you today" strip on the personal dashboard. Collapses the N
// shifts a coach works today into ONE entry — their earliest start, latest end,
// and shift count — so a coach with 7 blocks shows once, not seven rows, and
// the section count reflects PEOPLE on today, not shift rows.
//
// Pure + shared by web (SwapActions) + mobile (PersonalDashboard) so the
// grouping can't drift.

// Effective start/end for a shift row: the per-coach override wins, else the
// template default. Trimmed to HH:MM for display + comparison (lexicographic
// compare is correct for zero-padded 24h times).
function effStart(s) {
  return (s?.start_time_override || s?.shift_templates?.start_time || '').slice(0, 5)
}
function effEnd(s) {
  return (s?.end_time_override || s?.shift_templates?.end_time || '').slice(0, 5)
}

/**
 * @param {Array<object>} shifts  rows from /api/schedule/shifts (need profile_id,
 *   profiles.full_name, start_time_override/end_time_override, shift_templates)
 * @returns {Array<{ profileId: string, name: string, firstStart: string|null,
 *   lastEnd: string|null, count: number }>}  one entry per coach, sorted by
 *   earliest start then name.
 */
export function groupTeamShiftsByCoach(shifts) {
  const byCoach = new Map()
  for (const s of Array.isArray(shifts) ? shifts : []) {
    if (!s?.profile_id) continue
    const start = effStart(s)
    const end = effEnd(s)
    const existing = byCoach.get(s.profile_id)
    if (existing) {
      existing.count += 1
      if (start && (!existing.firstStart || start < existing.firstStart)) existing.firstStart = start
      if (end && (!existing.lastEnd || end > existing.lastEnd)) existing.lastEnd = end
    } else {
      byCoach.set(s.profile_id, {
        profileId: s.profile_id,
        name: s.profiles?.full_name || 'Coach',
        firstStart: start || null,
        lastEnd: end || null,
        count: 1,
      })
    }
  }
  return Array.from(byCoach.values()).sort((a, b) => {
    const as = a.firstStart || '99:99'
    const bs = b.firstStart || '99:99'
    if (as !== bs) return as < bs ? -1 : 1
    return (a.name || '').localeCompare(b.name || '')
  })
}

/**
 * Display label for a grouped coach's span — "05:45 – 20:30", or just the one
 * time if start === end, or whichever single bound exists.
 */
export function coachSpanLabel(coach) {
  if (!coach) return ''
  const { firstStart, lastEnd } = coach
  if (firstStart && lastEnd) return firstStart === lastEnd ? firstStart : `${firstStart} – ${lastEnd}`
  return firstStart || lastEnd || ''
}
