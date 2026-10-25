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

// ROSTER-TRIM.1 — the period the server says WOULD work, as a label.
// `suggested_period` is the smallest range covering both the publish that was
// refused and the roster(s) that refused it, so publishing it is the one
// action that actually resolves the overlap. Absent on an older server, and
// on any refusal where the server could not compute one.
export function suggestedPeriodLabel(data) {
  const p = data?.suggested_period
  if (!p?.start || !p?.end) return null
  return p.start === p.end ? p.start : `${p.start} to ${p.end}`
}

// ROSTER-TRIM.1 — what to do about it, from the PUBLISH modal.
//
// The old fixed sentence was "Re-publish that range instead", which on the
// refusal operators actually met (publish the month, having already published
// the week that runs into it) named a range that publishes the WEEK. It told
// them to do the thing they had already done. Name the period that covers
// both instead; fall back to the old wording only when the server sent no
// suggestion, where it is still better than nothing.
export function publishNextStep(data) {
  const span = suggestedPeriodLabel(data)
  return span
    ? `Publish ${span} instead, so one roster covers the whole span.`
    : 'Re-publish that range instead.'
}

// Same, from the APPROVALS queue: a draft cannot widen its own period, so the
// way out is to reject it and publish the covering range.
export function approveNextStep(data) {
  const span = suggestedPeriodLabel(data)
  return span
    ? `Reject this draft, then publish ${span} so one roster covers the whole span.`
    : 'Reject this draft and re-publish that range instead.'
}

// The whole sentence. `nextStep` is what THIS surface wants done about it.
// The ranges can legitimately be empty (the server sends the code before it
// sends rows), so the message still has to stand up without them.
export function overlapMessage(data, nextStep) {
  const ranges = overlapRanges(data)
  const step = nextStep || publishNextStep(data)
  return ranges
    ? `Those days are already published as part of ${ranges}. ${step}`
    : `Those days are already published as part of another roster. ${step}`
}

// For a call site holding a whole `{ success:false, error }` body: turn the
// overlap code into copy and pass anything else through, so a caller never
// alerts a raw error key.
export function rosterErrorMessage(data, { nextStep, fallback = 'Publish failed' } = {}) {
  if (data?.error !== OVERLAP_ERROR) return data?.error || fallback
  return overlapMessage(data, nextStep)
}
