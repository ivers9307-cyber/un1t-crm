'use client'

// FILTER-B.9 — "show me who matches", the operator-facing half.
//
// Until this, the only way to check an audience was to send to it: every
// surface showed a count and nothing else. A number cannot tell you that
// `time` means monthly-recurring, or that the tag you picked resolves to
// nobody you meant. A list of names can.
//
// Three deliberate constraints:
//  - COLLAPSED BY DEFAULT. Opening it is an act of checking. Rendering 50
//    customers' details on every screen that happens to contain a filter is
//    not a feature, it is an incident waiting for a screenshot.
//  - MASKED, AND NO EXPORT. The operator needs to recognise people, not
//    extract them. An export of a marketing audience is a different feature
//    with different consent implications, and is deliberately absent.
//  - IT SAYS WHICH QUESTION IT ANSWERS. On a send surface these are the
//    people who would actually RECEIVE the message (consent, status and
//    suppression already applied — the same query the send runs). On a
//    sequence there is no send, so it says "currently match" instead.

import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, AlertTriangle, Users } from 'lucide-react'

const PAGE_SIZE = 50

export default function AudiencePreview({
  locationId,
  filter,
  channel = null,
  mode = 'send',
  disabled = false,
}) {
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [state, setState] = useState('idle')   // 'idle' | 'loading' | 'ready' | 'error'
  const [page, setPage] = useState(null)
  const [error, setError] = useState(null)

  const filterKey = JSON.stringify(filter ?? null)

  // A changed filter invalidates the page — silently showing the previous
  // filter's people under the new filter's count would be the exact
  // disagreement this whole feature exists to prevent.
  useEffect(() => { setOffset(0); setPage(null); setState('idle') }, [filterKey, channel])

  const load = useCallback(async (nextOffset) => {
    setState('loading'); setError(null)
    try {
      const res = await fetch('/api/communications/audience-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          audience_filter: JSON.parse(filterKey),
          ...(channel ? { channel } : {}),
          limit: PAGE_SIZE,
          offset: nextOffset,
        }),
      })
      const json = await res.json()
      if (json?.success) { setPage(json.data); setState('ready') }
      else { setError(json?.error || `Couldn't load the preview (${res.status})`); setState('error') }
    } catch {
      setError('Couldn’t load the preview — check your connection and try again.')
      setState('error')
    }
  }, [locationId, filterKey, channel])

  function toggle() {
    if (open) { setOpen(false); return }
    setOpen(true)
    setOffset(0)
    load(0)
  }

  function go(nextOffset) {
    setOffset(nextOffset)
    load(nextOffset)
  }

  const total = page?.total ?? 0
  const shownFrom = total === 0 ? 0 : offset + 1
  const shownTo = Math.min(offset + (page?.rows?.length || 0), total)
  const hasNext = offset + PAGE_SIZE < total
  const hasPrev = offset > 0
  const matching = mode === 'matching' || page?.basis === 'matching'

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className="flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text transition-colors disabled:opacity-50"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? 'Hide who matches' : 'Show who matches'}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-un1t-border bg-un1t-surface p-3">
          {state === 'loading' && (
            <p className="flex items-center gap-1.5 text-xs text-un1t-subtle">
              <Loader2 size={12} className="animate-spin" /> loading…
            </p>
          )}

          {state === 'error' && (
            <p className="flex items-start gap-1.5 text-xs text-rose-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />{error}
            </p>
          )}

          {state === 'ready' && total === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-un1t-subtle">
              <Users size={12} /> Nobody matches this audience yet.
            </p>
          )}

          {state === 'ready' && total > 0 && (
            <>
              <p className="text-xs text-un1t-subtle mb-2">
                {matching
                  // SEQEXIT.1 — no send exists here, so there is nobody who
                  // "would receive it"; only people who currently match.
                  ? <><b className="text-un1t-text">{total.toLocaleString()}</b> contact{total === 1 ? '' : 's'} currently match this audience.</>
                  : <><b className="text-un1t-text">{total.toLocaleString()}</b> {total === 1 ? 'person' : 'people'} would receive this — consent, status and suppression already applied.</>}
              </p>

              <ul className="divide-y divide-un1t-border/60">
                {page.rows.map(r => (
                  <li key={r.id} className="flex items-center gap-2 py-1.5 text-xs">
                    <span className="text-un1t-text font-medium truncate">{r.name}</span>
                    <span className="text-un1t-muted font-mono truncate">{r.identifier || '—'}</span>
                    {r.stage && (
                      <span className="ml-auto shrink-0 rounded-full bg-slate-500/10 px-2 py-0.5 text-[11px] text-slate-700">
                        {r.stage.replace(/_/g, ' ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="mt-2 flex items-center gap-2 text-[11px] text-un1t-subtle">
                <span>Showing {shownFrom.toLocaleString()}–{shownTo.toLocaleString()} of {total.toLocaleString()}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {hasPrev && (
                    <button type="button" onClick={() => go(Math.max(offset - PAGE_SIZE, 0))}
                      className="underline hover:text-un1t-text">Previous</button>
                  )}
                  {hasNext && (
                    <button type="button" onClick={() => go(offset + PAGE_SIZE)}
                      className="underline hover:text-un1t-text">Next</button>
                  )}
                </span>
              </div>

              <p className="mt-2 text-[11px] text-un1t-muted">
                Contact details are masked — this is a check on the audience, not a list to take away.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
