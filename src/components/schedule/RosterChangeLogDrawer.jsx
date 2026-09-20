// src/components/schedule/RosterChangeLogDrawer.jsx
'use client'

// CHANGELOG.1 — "Changes since publish". Opened from the schedule's Published
// chip. Reads GET /api/schedule/change-log for the period on screen and prints
// each edit as a sentence (src/lib/roster-change-format.js).
//
// Three states that must never be confused: loading, an ERROR, and a genuinely
// empty period. An error is rendered as an error; "No changes" is only ever
// said about a read that succeeded.

import { useEffect, useState } from 'react'
import Modal from '@/components/ui/Modal'
import { rosterChangeSentence, rosterChangeTold, rosterChangeByline } from '@/lib/roster-change-format'
import { SESSION_ENDED_MESSAGE } from './useScheduleData'

export default function RosterChangeLogDrawer({ locationId, periodStart, periodEnd, periodLabel, onClose, restoreFocusRef }) {
  // Starts in `loading`, so the effect below never sets state synchronously.
  const [state, setState] = useState({ loading: true, error: null, changes: [], truncated: false })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/schedule/change-log?location_id=${locationId}&from=${periodStart}&to=${periodEnd}`)
        const body = await res.json().catch(() => null)
        // The generation guard in its effect-scoped form: a response for a
        // period that is no longer the one on screen writes nothing.
        if (cancelled) return
        if (res.status === 401) {
          // ROSTER-FIX.6a-8 — a dead session is not a server fault. Same words
          // as the rest of the schedule screen.
          setState({ loading: false, error: SESSION_ENDED_MESSAGE, changes: [], truncated: false })
          return
        }
        if (!res.ok || !body?.success) {
          setState({ loading: false, error: body?.error || `Could not load the changes (${res.status})`, changes: [], truncated: false })
          return
        }
        setState({ loading: false, error: null, changes: body.data?.changes || [], truncated: Boolean(body.data?.truncated) })
      } catch {
        // ROSTER-FIX.6a — never print e.message: a dropped connection reaches
        // the operator as "Failed to fetch".
        if (!cancelled) setState({ loading: false, error: 'Network error, could not load the changes.', changes: [], truncated: false })
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId, periodStart, periodEnd])

  const { loading, error, changes, truncated } = state
  const untold = changes.filter((c) => !c.notified_at).length

  return (
    <Modal open onClose={onClose} title="Changes since publish" size="lg" restoreFocusRef={restoreFocusRef}>
      <div>
        <div className="text-xs text-un1t-subtle mb-3">{periodLabel}</div>

        {loading && (
          <div className="text-center py-6 text-sm text-un1t-subtle">Loading changes…</div>
        )}

        {!loading && error && (
          <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && changes.length === 0 && (
          <div className="py-6 text-center">
            <div className="text-sm text-un1t-text">No changes since this was published.</div>
            <p className="text-xs text-un1t-subtle mt-1">
              Only edits to shifts on a published roster are recorded here. Edits to a week that is not published yet are part of its first publish.
            </p>
          </div>
        )}

        {!loading && !error && changes.length > 0 && (
          <>
            <div data-testid="roster-change-summary" className="text-xs text-un1t-subtle mb-2">
              {changes.length} change{changes.length === 1 ? '' : 's'}
              {untold > 0 && (
                <span className="text-amber-700"> · {untold} not told yet. Publish again to tell them.</span>
              )}
            </div>
            {/* A scrolling box with nothing focusable inside cannot be scrolled
                from the keyboard, so the box itself takes focus and a name. */}
            <div
              role="region"
              aria-label="Changes, newest first"
              tabIndex={0}
              className="max-h-[60vh] overflow-y-auto rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
            >
              <ul data-testid="roster-change-list" className="divide-y divide-un1t-border">
                {changes.map((c) => {
                // null = stamped, but the stamp does not mean anybody was told
                // (stampMeansTold): no chip, rather than a time nobody was told at.
                const told = rosterChangeTold(c)
                return (
                  <li key={c.id} className="py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-sm text-un1t-text">
                        {rosterChangeSentence(c)}
                        {c.shift_name ? <span className="text-un1t-subtle"> · {c.shift_name}</span> : null}
                      </span>
                      {told && (
                        <span
                          data-testid="roster-change-told"
                          className={`flex-shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded ${c.notified_at ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}`}
                        >
                          {told}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-un1t-subtle mt-0.5">{rosterChangeByline(c)}</div>
                  </li>
                )
              })}
              </ul>
            </div>
            {truncated && (
              <p className="text-xs text-un1t-subtle mt-2">Showing the most recent 5,000. Pick a shorter period to see older ones.</p>
            )}
          </>
        )}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-md text-sm border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
