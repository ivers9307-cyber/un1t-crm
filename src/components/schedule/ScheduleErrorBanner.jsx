'use client'

// ROSTER-FIX.6a — the schedule screens all failed the same way: a fetch that
// threw or answered non-OK left `loading` true forever and said nothing, so
// the operator stared at "Loading requests..." with no idea the request had
// been refused (memory: discarded-error defect class). This is the one thing
// they render instead: what failed, in the server's own words where there are
// any, plus a retry and a dismiss.

import { AlertCircle, X } from 'lucide-react'

export default function ScheduleErrorBanner({ title = 'Something went wrong', message, onRetry, onDismiss, busy }) {
  return (
    <div className="mb-4 flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-sm">
      <AlertCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="font-medium text-red-700">{title}</div>
        {message && <div className="text-xs text-red-700/80 mt-0.5">{message}</div>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={() => onRetry()}
          disabled={busy}
          className="text-xs font-medium px-2.5 py-1 rounded border border-red-500/40 text-red-700 hover:bg-red-500/15 disabled:opacity-50"
        >
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-red-700/70 hover:text-red-700"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
