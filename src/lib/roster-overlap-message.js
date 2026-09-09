// ROSTER-FIX.4 — one copy of the "those days are already published" sentence.
//
// Two surfaces refuse on the same server error: the publish modal
// (ScheduleCalendar) and the approvals queue (RosterApprovalActions), because
// approving IS publishing and runs the same overlap guard. Each had grown its
// own near-identical wording, and they had already drifted — one joined a
// range with an en dash, the other with "to" — so the operator met two
// different sentences for one refusal. Only the closing instruction actually
// differs between them, so that is the parameter.
//
// Client-safe on purpose: no server or payroll import, so a 'use client'
// component can pull it in without dragging the cost engine into the bundle.

// The server's code for the refusal (POST /api/schedule/rosters and
// .../rosters/[id]/approve both return it). A code, not copy — never alert it.
export const OVERLAP_ERROR = 'overlapping_roster'

// "2026-05-04 to 2026-05-10, 2026-06-01" — a single-day roster reads as one
// date rather than a range repeating itself.
export function overlapRanges(data) {
  return (data?.overlapping || [])
    .map((r) => (r.period_start === r.period_end ? r.period_start : `${r.period_start} to ${r.period_end}`))
    .join(', ')
}

// The whole sentence. `nextStep` is what THIS surface wants done about it.
// The ranges can legitimately be empty (the server sends the code before it
// sends rows), so the message still has to stand up without them.
export function overlapMessage(data, nextStep = 'Re-publish that range instead.') {
  const ranges = overlapRanges(data)
  return ranges
    ? `Those days are already published as part of ${ranges}. ${nextStep}`
    : `Those days are already published as part of another roster. ${nextStep}`
}

// For a call site holding a whole `{ success:false, error }` body: turn the
// overlap code into copy and pass anything else through, so a caller never
// alerts a raw error key.
export function rosterErrorMessage(data, { nextStep, fallback = 'Publish failed' } = {}) {
  if (data?.error !== OVERLAP_ERROR) return data?.error || fallback
  return overlapMessage(data, nextStep)
}
