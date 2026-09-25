// src/components/schedule/RosterCompareSection.jsx
'use client'

// SNAPSHOT.1 — "Published vs now", inside the change-log dialog. One section
// per published roster the period on screen sits on (a Mon-Sun week can
// straddle two month rosters), each reading
// GET /api/schedule/rosters/[id]/compare for that period.
//
// Four states that must never be confused: loading, an ERROR, a roster with
// no snapshot (published before snapshots began, or not saved at the time),
// and a real comparison. Only the last can say "Every shift is as it was
// published". "No arrival recorded" is advisory and worded that way.

import { useEffect, useState } from 'react'
import { readJson } from './useScheduleData'
import {
  COMPARE_CHANGE_LABELS, COMPARE_CHANGE_CHIP, ARRIVAL_CAVEAT,
  dayLabel, periodLabel, publishedLabel, windowLabel,
  totalsSentence, changeCountsSentence, arrivalSentence,
  compareRowSummary, arrivalLabel, blockChangeNotes,
  missingSnapshotMessage, publishOptionLabel, visibleCompareBlocks,
} from '@/lib/roster-compare-format'

export const MAX_COMPARE_ROSTERS = 4

export default function RosterCompareSection({ rosterIds, from, to }) {
  const [showUnchanged, setShowUnchanged] = useState(false)
  const all = rosterIds || []
  const ids = all.slice(0, MAX_COMPARE_ROSTERS)

  if (ids.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-un1t-subtle">
        Nothing in this period is on a published roster, so there is nothing to compare.
      </p>
    )
  }

  return (
    <div data-testid="roster-compare-section">
      <p className="text-xs text-un1t-subtle mb-2">
        What was published, against who is rostered now and who arrived. Nothing here alerts anyone.
      </p>
      <label className="inline-flex items-center gap-2 text-xs text-un1t-text mb-3">
        <input
          type="checkbox"
          checked={showUnchanged}
          onChange={(e) => setShowUnchanged(e.target.checked)}
        />
        Show unchanged shifts
      </label>
      <div className="space-y-4">
        {ids.map((id) => (
          <RosterCompareOne key={id} rosterId={id} from={from} to={to} showUnchanged={showUnchanged} />
        ))}
      </div>
      {all.length > ids.length && (
        <p className="text-xs text-un1t-subtle mt-2">
          Showing the first {ids.length} of {all.length} rosters in this period. Pick a shorter period to see the rest.
        </p>
      )}
    </div>
  )
}

function RosterCompareOne({ rosterId, from, to, showUnchanged }) {
  const [against, setAgainst] = useState(null)
  // Starts in `loading`, so the effect never sets state synchronously.
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    // Effect-scoped generation guard: an answer for a baseline or period that
    // is no longer the one asked for writes nothing.
    let cancelled = false
    async function load() {
      try {
        const qs = new URLSearchParams({ from, to })
        if (against) qs.set('against', against)
        const body = await readJson(`/api/schedule/rosters/${rosterId}/compare?${qs.toString()}`)
        if (cancelled) return
        setState({ loading: false, error: null, data: body.data || null })
      } catch (e) {
        if (cancelled) return
        const message = e instanceof TypeError || !e?.message
          ? 'Network error, could not load the comparison.'
          : e.message
        setState((s) => ({ loading: false, error: message, data: s.data }))
      }
    }
    load()
    return () => { cancelled = true }
  }, [rosterId, from, to, against])

  // The previous answer stays on screen while the new one loads, so the select
  // the manager just used keeps its focus.
  function chooseBaseline(snapshotId) {
    setState((s) => ({ ...s, loading: true, error: null }))
    setAgainst(snapshotId || null)
  }

  const { loading, error, data } = state
  const headingId = `roster-compare-${rosterId}`
  return (
    <section
      aria-labelledby={headingId}
      data-testid="roster-compare"
      className="rounded-md border border-un1t-border p-3"
    >
      <h3 id={headingId} className="text-sm font-medium text-un1t-text">
        {data?.roster ? `Roster ${periodLabel(data.roster.period_start, data.roster.period_end)}` : 'Roster'}
      </h3>
      {loading && !data && <div className="py-3 text-sm text-un1t-subtle">Loading the comparison…</div>}
      {loading && data && <div className="text-xs text-un1t-subtle" aria-live="polite">Updating…</div>}
      {!loading && error && (
        <div role="alert" className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!error && data && (
        <CompareBody data={data} rosterId={rosterId} showUnchanged={showUnchanged} onChooseBaseline={chooseBaseline} />
      )}
    </section>
  )
}

function CompareBody({ data, rosterId, showUnchanged, onChooseBaseline }) {
  if (!data.baseline) {
    return (
      <p data-testid="roster-compare-missing" className="mt-2 text-sm text-un1t-subtle">
        {missingSnapshotMessage(data)}
      </p>
    )
  }
  const t = data.totals
  const shown = visibleCompareBlocks(data.blocks, showUnchanged)
  const arrival = arrivalSentence(t)
  const selectId = `roster-compare-against-${rosterId}`
  return (
    <div className="mt-1">
      <div className="text-xs text-un1t-subtle">
        Compared with the publish of {publishedLabel(data.baseline.published_at)}
        {data.baseline.published_by_name ? ` by ${data.baseline.published_by_name}` : ''}
      </div>
      {(data.publishes || []).length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor={selectId} className="text-un1t-subtle">Compare with</label>
          <select
            id={selectId}
            value={data.baseline.snapshot_id}
            onChange={(e) => onChooseBaseline(e.target.value)}
            className="max-w-full rounded-md border border-un1t-border bg-un1t-surface px-2 py-1 text-xs text-un1t-text"
          >
            {data.publishes.map((p) => (
              <option key={p.snapshot_id} value={p.snapshot_id}>{publishOptionLabel(p, rosterId)}</option>
            ))}
          </select>
        </div>
      )}
      <div data-testid="roster-compare-totals" className="mt-2 text-sm text-un1t-text">{totalsSentence(t)}</div>
      <div className="text-xs text-un1t-subtle">{changeCountsSentence(t)}</div>
      {arrival && <div className="mt-1 text-xs text-un1t-subtle">{arrival}. {ARRIVAL_CAVEAT}</div>}

      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-un1t-subtle">
          {showUnchanged ? 'No shifts in this period.' : 'Every shift is as it was published.'}
        </p>
      ) : (
        <ul data-testid="roster-compare-list" className="mt-3 divide-y divide-un1t-border">
          {shown.map((b) => (
            <li key={b.slot} className="py-2">
              <div className="text-sm text-un1t-text">
                {dayLabel(b.date)} · {windowLabel(b.current || b.published)} · {b.template_name || 'Shift'}
              </div>
              {blockChangeNotes(b).map((note) => (
                <div key={note} className="text-[11px] text-amber-700">{note}</div>
              ))}
              {b.coaches.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {b.coaches.map((r) => {
                    const arrivalText = arrivalLabel(r)
                    return (
                      <li
                        key={r.profile_id}
                        data-testid="roster-compare-coach"
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                      >
                        <span className="text-un1t-text">{r.name || 'Name unavailable'}</span>
                        <span className="text-un1t-subtle">{compareRowSummary(r)}</span>
                        <span className={`px-1.5 py-0.5 rounded font-medium ${COMPARE_CHANGE_CHIP[r.change]}`}>
                          {COMPARE_CHANGE_LABELS[r.change]}
                        </span>
                        {arrivalText && (
                          <span
                            className={`px-1.5 py-0.5 rounded font-medium ${r.no_show_candidate ? 'bg-amber-500/10 text-amber-700' : 'bg-green-500/10 text-green-700'}`}
                          >
                            {arrivalText}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
