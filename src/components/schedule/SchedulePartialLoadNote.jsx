'use client'

// ROSTERLOAD.1 — useScheduleData stopped failing the whole roster when one of
// its side reads fails (leave, bank holidays, coach list, templates, contractor
// spend). That is only honest if the missing slice is SAID: an empty leave
// slice nobody mentions reads as "nobody is on leave", and a manager rosters
// over approved leave on the strength of it. This is the quieter sibling of
// ScheduleErrorBanner: amber, not red, because the roster itself is fine, and
// specific about what is missing and what that means for the operator.

import { Info } from 'lucide-react'

export const STAFF_UNAVAILABLE_MESSAGE =
  'The coach list could not be loaded, so assigning coaches is unavailable.'
export const TEMPLATES_UNAVAILABLE_MESSAGE =
  'Shift templates could not be loaded, so adding a shift slot is unavailable.'
// Shown inside the assign picker, where the missing leave would otherwise
// just look like no coach being on leave.
export const LEAVE_NOT_FLAGGED_MESSAGE =
  'Leave could not be loaded, so coaches on leave are not flagged here.'

// [slice, managerOnly, copy when cleared, copy when an earlier load is kept,
//  optional coach copy when cleared]
const COPY = [
  ['timeOff', false,
    'Leave could not be loaded. Days off are not shown, so check leave before assigning coaches.',
    'Leave could not be refreshed. Showing leave as it last loaded.',
    // ROSTERLOAD.1 (review nit) — a coach does not assign anyone, so the
    // manager's "check leave before assigning" is the wrong instruction.
    'Leave could not be loaded, so days off are not shown.'],
  ['holidays', false,
    'Bank holidays and closures could not be loaded, so they are not marked on the calendar.',
    'Bank holidays and closures could not be refreshed. Showing them as they last loaded.'],
  ['staff', true,
    STAFF_UNAVAILABLE_MESSAGE,
    'The coach list could not be refreshed. Showing the list that loaded earlier.'],
  ['templates', true,
    TEMPLATES_UNAVAILABLE_MESSAGE,
    'Shift templates could not be refreshed. Showing the list that loaded earlier.'],
  ['contractorSpend', true,
    'Contractor spend could not be loaded.',
    'Contractor spend could not be refreshed. Showing the last figure that loaded.'],
]

/**
 * The lines to show for the hook's `partialErrors`. A coach is only told
 * about what their calendar shows (leave, holidays); the coach list,
 * templates and spend only feed manager actions and panels.
 */
export function partialLoadLines(partialErrors, { isManager }) {
  if (!partialErrors) return []
  return COPY
    .filter(([key, managerOnly]) => partialErrors[key] && (isManager || !managerOnly))
    .map(([key, , cleared, kept, coachCleared]) => {
      if (partialErrors[key].kept) return kept
      return !isManager && coachCleared ? coachCleared : cleared
    })
}

export default function SchedulePartialLoadNote({ partialErrors, isManager, onRetry, busy }) {
  const lines = partialLoadLines(partialErrors, { isManager })
  if (lines.length === 0) return null
  return (
    <div
      role="status"
      data-testid="schedule-partial-load-note"
      className="mb-4 flex items-start gap-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm"
    >
      <Info size={16} className="text-amber-700 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <ul className="flex-1 space-y-0.5 text-xs text-amber-700">
        {lines.map(line => <li key={line}>{line}</li>)}
      </ul>
      {onRetry && (
        <button
          type="button"
          onClick={() => onRetry()}
          disabled={busy}
          className="text-xs font-medium px-2.5 py-1 rounded border border-amber-500/40 text-amber-700 hover:bg-amber-500/15 disabled:opacity-50"
        >
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  )
}
