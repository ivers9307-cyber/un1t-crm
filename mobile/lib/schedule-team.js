// Pure helpers for the Schedule tab's Team view (the Me / Team toggle).
//
// Lives in mobile/lib so the root vitest picks it up (vitest.config.js
// includes mobile/lib/**). No React, no Supabase — pure functions over the
// shift-row shape returned by GET /api/schedule/shifts (see
// src/lib/roster-read.js#toApiShiftRow): each row carries start_time_override
// (collapsed EFFECTIVE override, or null), shift_templates { start_time,
// end_time, name, role_label }, shift_date, profile_id, and
// profiles { id, full_name, avatar_url, role }.

// Effective shift times. Resolve override → block → template → (legacy row).
// Single definition shared by the Team sort helper AND the Schedule screen
// (which imports these back).
//
// ROSTER-FIX.1 — `block_start_time` / `block_end_time` sit ahead of the
// template default. The API row carries the BLOCK's own time (roster-read.js
// #toApiShiftRow) and no top-level start_time, so the old chain fell straight
// through to the template — a block moved off its template's hours displayed
// and sorted at the template time, which is the one time nobody works.
export const effShiftStart = (s) =>
  s?.start_time_override || s?.block_start_time || s?.shift_templates?.start_time || s?.start_time || null
export const effShiftEnd = (s) =>
  s?.end_time_override || s?.block_end_time || s?.shift_templates?.end_time || s?.end_time || null

// Up-to-2-letter initials for an avatar fallback: first letter of the first
// word + first letter of the last word, uppercased. Single word → one letter.
// Empty / missing → '?'.
export function initials(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// The selected day's team roster: every shift whose shift_date === iso,
// sorted by effective start time then assignee name, each annotated with
// isSelf (true for the signed-in user's own rows). Pure — no IO.
export function teamRosterForDay(shifts, iso, selfProfileId) {
  return (Array.isArray(shifts) ? shifts : [])
    .filter((s) => s && s.shift_date === iso)
    .map((s) => ({ ...s, isSelf: s.profile_id === selfProfileId }))
    .sort((a, b) => {
      const sa = effShiftStart(a) || ''
      const sb = effShiftStart(b) || ''
      if (sa !== sb) return sa < sb ? -1 : 1
      return (a.profiles?.full_name || '').localeCompare(b.profiles?.full_name || '')
    })
}
