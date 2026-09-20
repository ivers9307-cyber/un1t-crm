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
import {
  rosterChangeSentence, rosterChangeTold, rosterChangeByline, ROSTER_CHANGE_LOG_MAX_ROWS,
} from '@/lib/roster-change-format'
import { readJson } from './useScheduleData'

export default function RosterChangeLogDrawer({ locationId, periodStart, periodEnd, periodLabel, onClose, restoreFocusRef }) {
  // Starts in `loading`, so the effect below never sets state synchronously.
  const [state, setState] = useState({ loading: true, error: null, changes: [], truncated: false })

  useEffect(() => {
    // The generation guard in its effect-scoped form: a response for a period
    // that is no longer the one on screen (or for a drawer that has closed)
    // writes nothing.
    let cancelled = false
    async function load() {
      try {
        // readJson is the schedule screen's one reader: it THROWS on anything
        // that is not a success, in words an operator can act on. A dead
        // session reads as signed out whether it arrives as a 401 or, as in
        // production, as a followed redirect to /login (200 + HTML); a 403
        // keeps the server's own sentence.
        const body = await readJson(`/api/schedule/change-log?location_id=${locationId}&from=${periodStart}&to=${periodEnd}`)
        if (cancelled) return
        setState({ loading: false, error: null, changes: body.data?.changes || [], truncated: Boolean(body.data?.truncated) })
      } catch (e) {
        if (cancelled) return
        // ROSTER-FIX.6a — fetch rejects with a TypeError when the connection
        // drops, and its message ("Failed to fetch") is not for an operator.
        // Everything readJson throws itself is a plain Error written for one.
        const message = e instanceof TypeError || !e?.message
          ? 'Network error, could not load the changes.'
          : e.message
        setState({ loading: false, error: message, changes: [], truncated: false })
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId, periodStart, periodEnd])

  const { loading, error, changes, truncated } = state
  const untold = changes.filter((c) => !c.notified_at).length

  return (
    <Modal
      open
      onClose={onClose}
      title="Changes since publish"
      size="lg"
      restoreFocusRef={restoreFocusRef}
      footer={(
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-md text-sm border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30"
        >
          Close
        </button>
      )}
    >
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
                from the keyboard, so the box itself takes focus and a name.

                ONE scroller, not two. Modal's body scrolls too, and a fixed
                60vh list inside it double-scrolled on a short viewport. The cap
                is the viewport minus everything else the dialog stacks: 2rem
                of backdrop padding, the header and footer bars (~3.1rem and
                ~3.6rem), the body's 2rem of padding, and the period, summary
                and cut-short lines above and below the list (~5rem). 17rem
                leaves a little slack, so the body never needs its own scroll
                while the list has room; min-h keeps a usable list on a very
                short screen, where the body scrolling is the lesser evil. */}
            <div
              role="region"
              aria-label="Changes, newest first"
              tabIndex={0}
              className="max-h-[calc(100vh-17rem)] min-h-[6rem] overflow-y-auto rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
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
              <p className="text-xs text-un1t-subtle mt-2">Showing the most recent {ROSTER_CHANGE_LOG_MAX_ROWS.toLocaleString('en-IE')}. Pick a shorter period to see older ones.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
