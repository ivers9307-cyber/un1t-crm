'use client'

// Moved out of InvoicesManager (APPROVALSQ.4) so the /approvals card can use it
// without importing the whole manager. InvoicesManager re-exports it.
import { AlertCircle } from 'lucide-react'

// INVOICEHOURS.1 — what the comparison above leaves out, said plainly.
//   - roster_unavailable (GET /api/invoices/[id]): the live roster read
//     failed; with no snapshot to fall back on there is no comparison at
//     all, so say so rather than show nothing (approval also refuses with a
//     503 until the read works). Only a 'submitted' invoice can be approved,
//     so only that one is told to refresh before approving.
//   - unpublished_*: shifts on rosters nobody published are not scheduled
//     (D1), but a contractor may still have worked one; show the hours so a
//     correct invoice reading "over roster" has its explanation beside it.
export function RosterCheckNotes({ data }) {
  const unavailable = !!data?.roster_unavailable && !data?.review_comparison
  const live = data?.computed_scheduled
  const unpublishedShifts = Number(live?.unpublished_shift_count) || 0
  const unpublishedHours = Number(live?.unpublished_hours) || 0
  if (!unavailable && unpublishedShifts === 0) return null
  return (
    <div className="space-y-1.5 text-xs">
      {unavailable && (
        <p role="alert" className="text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded p-2 flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            {data?.status === 'submitted'
              ? 'Could not read the roster for this period, so there is no schedule comparison. Refresh before approving.'
              : "Couldn't read the roster for this period."}
          </span>
        </p>
      )}
      {unpublishedShifts > 0 && (
        <p className="text-un1t-subtle">
          Not counted: {unpublishedHours} h on {unpublishedShifts} {unpublishedShifts === 1 ? 'shift' : 'shifts'} in rosters that were not published.
        </p>
      )}
    </div>
  )
}
