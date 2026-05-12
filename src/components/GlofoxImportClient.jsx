'use client'

import { useCallback, useMemo, useState } from 'react'

// GLOFOX2.3 — interactive import UI on top of /api/glofox/bulk-sync.
//
// State machine per page session:
//   idle        — operator hasn't done anything
//   previewing  — bulk-sync dry_run=true in flight
//   previewed   — preview complete, "Apply" enabled
//   applying    — single-batch dry_run=false in flight
//   paginating  — auto-paginate loop running
//   done        — final batch returned has_more=false
//   error       — last call threw / returned !ok
//
// All state lives in component memory — no localStorage. If the
// browser closes mid-loop, anything already committed stays
// committed (per-batch atomicity). Operator restarts from the
// current `skip` value on reload.

const ALL_LEAD_STATUSES = [
  'COLD', 'TOUR', 'NO_SALE_TOUR',
  'TRIAL', 'NO_SALE_TRIAL',
  'MEMBER', 'LEAD',
]

const ACTION_BADGE = {
  create:    { label: 'Create',    cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  update:    { label: 'Update',    cls: 'bg-blue-100 text-blue-800 border-blue-200' },
  leave:     { label: 'Leave',     cls: 'bg-neutral-100 text-neutral-700 border-neutral-200' },
  ambiguous: { label: 'Ambiguous', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  invalid:   { label: 'Invalid',   cls: 'bg-red-100 text-red-800 border-red-200' },
  error:     { label: 'Error',     cls: 'bg-red-100 text-red-800 border-red-200' },
}

const EMPTY_SUMMARY = { create: 0, update: 0, leave: 0, ambiguous: 0, invalid: 0, error: 0 }

export default function GlofoxImportClient({
  activeLocationId,
  activeLocationName,
  crmContactsLinked,
  crmContactsTotal,
  recentRuns,
}) {
  // ── Filter form state ───────────────────────────────────────
  const [leadStatuses, setLeadStatuses] = useState([]) // empty = no filter
  const [modifiedSince, setModifiedSince] = useState('') // YYYY-MM-DD
  const [skip, setSkip] = useState(0)
  const [limit, setLimit] = useState(50)

  // ── Run state ───────────────────────────────────────────────
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState(null)
  const [previewResult, setPreviewResult] = useState(null) // last bulk-sync response
  const [cumulative, setCumulative] = useState({ ...EMPTY_SUMMARY, leads_processed: 0, pages_fetched: 0, started_at: null })
  const [cancelRequested, setCancelRequested] = useState(false)

  const filterBody = useMemo(() => {
    const filters = {}
    if (leadStatuses.length > 0) filters.lead_status = leadStatuses
    if (modifiedSince) {
      const sec = Math.floor(new Date(modifiedSince + 'T00:00:00Z').getTime() / 1000)
      if (Number.isFinite(sec)) filters.modified = { start: sec }
    }
    return filters
  }, [leadStatuses, modifiedSince])

  // Single-batch fetch — used by both Preview and Apply paths.
  const callBulkSync = useCallback(async ({ dryRun, atSkip }) => {
    const res = await fetch('/api/glofox/bulk-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: activeLocationId,
        filters: filterBody,
        pagination: { skip: atSkip, limit },
        dry_run: dryRun,
      }),
    })
    const json = await res.json()
    if (!json.ok) throw new Error(json.error || 'bulk-sync failed')
    return json
  }, [activeLocationId, filterBody, limit])

  // ── Actions ─────────────────────────────────────────────────

  async function preview() {
    setPhase('previewing')
    setError(null)
    setPreviewResult(null)
    try {
      const json = await callBulkSync({ dryRun: true, atSkip: skip })
      setPreviewResult(json)
      setPhase('previewed')
    } catch (e) {
      setError(e?.message || 'Preview failed')
      setPhase('error')
    }
  }

  async function applyOne() {
    setPhase('applying')
    setError(null)
    try {
      const json = await callBulkSync({ dryRun: false, atSkip: skip })
      setPreviewResult(json)
      // Move skip forward so the operator can keep paginating manually.
      const nextSkip = skip + (json.fetched || 0)
      setSkip(nextSkip)
      // Roll into cumulative (single-batch counts here).
      setCumulative((c) => addToCumulative(c, json))
      setPhase(json.has_more ? 'idle' : 'done')
    } catch (e) {
      setError(e?.message || 'Apply failed')
      setPhase('error')
    }
  }

  async function autoPaginate() {
    setPhase('paginating')
    setError(null)
    setCancelRequested(false)
    setCumulative({ ...EMPTY_SUMMARY, leads_processed: 0, pages_fetched: 0, started_at: new Date().toISOString() })

    let currentSkip = skip
    while (true) {
      if (cancelRequested) {
        setPhase('idle')
        return
      }
      let json
      try {
        json = await callBulkSync({ dryRun: false, atSkip: currentSkip })
      } catch (e) {
        setError(e?.message || 'Auto-paginate failed mid-loop')
        setPhase('error')
        return
      }
      setPreviewResult(json)
      setCumulative((c) => addToCumulative(c, json))
      currentSkip += (json.fetched || 0)
      setSkip(currentSkip)
      if (!json.has_more || (json.fetched || 0) < limit) break
    }
    setPhase('done')
  }

  function reset() {
    setPhase('idle')
    setError(null)
    setPreviewResult(null)
    setCumulative({ ...EMPTY_SUMMARY, leads_processed: 0, pages_fetched: 0, started_at: null })
    setSkip(0)
    setCancelRequested(false)
  }

  function toggleLeadStatus(s) {
    setLeadStatuses((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])
  }

  const isBusy = phase === 'previewing' || phase === 'applying' || phase === 'paginating'

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Status panel */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Active location" value={activeLocationName || '—'} />
        <Tile label="CRM contacts at location" value={crmContactsTotal.toLocaleString()} />
        <Tile label="Linked to Glofox" value={crmContactsLinked.toLocaleString()} />
        <Tile label="Last cron run"
              value={recentRuns?.[0]?.started_at ? timeAgo(recentRuns[0].started_at) : 'never'} />
      </div>

      {/* Filter form */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h3 className="text-sm font-semibold mb-3">Filter (optional)</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-600 mb-1">Lead status (any)</label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_LEAD_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleLeadStatus(s)}
                  disabled={isBusy}
                  className={`text-xs px-2 py-1 rounded border ${
                    leadStatuses.includes(s)
                      ? 'bg-blue-100 border-blue-300 text-blue-800'
                      : 'bg-neutral-50 border-neutral-200 text-neutral-700 hover:bg-neutral-100'
                  } ${isBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {s}
                </button>
              ))}
              {leadStatuses.length === 0 && (
                <span className="text-xs text-neutral-500 px-1 py-1">(no filter — pulls every lead_status)</span>
              )}
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">
              Applied client-side after fetching. Pages may show fewer members than the page size when a filter is set.
            </p>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-600 mb-1">
              Modified since (Glofox-side)
            </label>
            <input
              type="date"
              value={modifiedSince}
              onChange={(e) => setModifiedSince(e.target.value)}
              disabled={isBusy}
              className="w-full bg-white border border-neutral-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
            />
            <p className="text-[11px] text-neutral-500 mt-1">
              Empty = pull every member. /2.0/members is sorted modified-DESC, so a date here is most efficient when used with Auto-paginate (we early-stop once we hit the cutoff).
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-600 mb-1">Skip</label>
            <input
              type="number"
              min={0}
              value={skip}
              onChange={(e) => setSkip(Math.max(0, parseInt(e.target.value || '0', 10)))}
              disabled={isBusy}
              className="w-full bg-white border border-neutral-300 rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wide text-neutral-600 mb-1">Limit (per page)</label>
            <input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Math.min(100, Math.max(1, parseInt(e.target.value || '50', 10))))}
              disabled={isBusy}
              className="w-full bg-white border border-neutral-300 rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-blue-400"
            />
            <p className="text-[11px] text-neutral-500 mt-1">Max 100 (Glofox API ceiling).</p>
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h3 className="text-sm font-semibold mb-3">Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={preview}
            disabled={isBusy}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 disabled:opacity-50"
          >
            {phase === 'previewing' ? 'Previewing…' : 'Preview batch'}
          </button>
          <button
            onClick={applyOne}
            disabled={isBusy || phase !== 'previewed'}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            title={phase !== 'previewed' ? 'Preview a batch first to enable Apply' : ''}
          >
            {phase === 'applying' ? 'Applying…' : 'Apply this batch'}
          </button>
          <button
            onClick={autoPaginate}
            disabled={isBusy}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-purple-300 bg-purple-50 text-purple-800 hover:bg-purple-100 disabled:opacity-50"
            title="Loop bulk-sync from current skip until has_more=false. Live progress below."
          >
            {phase === 'paginating' ? 'Paginating…' : 'Auto-paginate (apply all)'}
          </button>
          {phase === 'paginating' && (
            <button
              onClick={() => setCancelRequested(true)}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-red-300 bg-red-50 text-red-800 hover:bg-red-100"
            >
              Stop after current page
            </button>
          )}
          <button
            onClick={reset}
            disabled={isBusy}
            className="ml-auto px-3 py-1.5 text-sm font-medium rounded-md border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            Reset
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* Cumulative progress (shown during/after auto-paginate) */}
        {(phase === 'paginating' || phase === 'done' || cumulative.pages_fetched > 0) && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-wide text-neutral-600">Cumulative progress</span>
              <span className="text-xs text-neutral-600">
                {cumulative.pages_fetched} page{cumulative.pages_fetched === 1 ? '' : 's'} ·{' '}
                {cumulative.leads_processed} member{cumulative.leads_processed === 1 ? '' : 's'}
                {previewResult?.total_available != null && (
                  <> · of ~{previewResult.total_available.toLocaleString()} total</>
                )}
              </span>
            </div>
            {previewResult?.total_available != null && previewResult.total_available > 0 && (
              <div className="h-2 bg-neutral-200 rounded overflow-hidden mb-2">
                <div
                  className="h-full bg-purple-500 transition-all"
                  style={{ width: `${Math.min(100, Math.round(100 * cumulative.leads_processed / previewResult.total_available))}%` }}
                />
              </div>
            )}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-xs">
              {Object.entries(EMPTY_SUMMARY).map(([k]) => (
                <span key={k} className={`inline-flex items-center justify-between rounded border px-2 py-1 ${ACTION_BADGE[k]?.cls || 'bg-neutral-100 text-neutral-700 border-neutral-200'}`}>
                  <span className="font-medium">{ACTION_BADGE[k]?.label || k}</span>
                  <span className="font-mono">{cumulative[k] || 0}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Last batch result table */}
      {previewResult && (
        <section className="rounded-xl border border-neutral-200 bg-white">
          <header className="px-4 py-3 border-b border-neutral-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">
                {phase === 'previewing' || phase === 'previewed'
                  ? 'Preview (no DB writes)'
                  : 'Last batch result'}
              </h3>
              <p className="text-xs text-neutral-500 mt-0.5">
                Fetched {previewResult.fetched} member{previewResult.fetched === 1 ? '' : 's'}
                {previewResult.total_available != null && (
                  <> · {previewResult.total_available.toLocaleString()} total at the location</>
                )}
                {previewResult.has_more === true && <> · more pages available</>}
                {previewResult.has_more === false && <> · last page</>}
              </p>
            </div>
            <div className="flex gap-1.5">
              {Object.entries(previewResult.summary || {}).map(([k, v]) => (
                v > 0 && (
                  <span key={k} className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${ACTION_BADGE[k]?.cls || 'bg-neutral-100 text-neutral-700 border-neutral-200'}`}>
                    <span className="font-medium">{ACTION_BADGE[k]?.label || k}</span>
                    <span className="font-mono">{v}</span>
                  </span>
                )
              ))}
            </div>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-600">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Glofox id</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Deal action</th>
                  <th className="px-3 py-2">Interactions</th>
                  <th className="px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(previewResult.processed || []).map((p, i) => (
                  <tr key={p.glofox_member_id || i} className="border-t border-neutral-100">
                    <td className="px-3 py-2">{p.name || <span className="text-neutral-400">—</span>}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-neutral-600">
                      {p.glofox_member_id ? p.glofox_member_id.slice(0, 12) + '…' : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium ${ACTION_BADGE[p.action]?.cls || 'bg-neutral-100 text-neutral-700 border-neutral-200'}`}>
                        {ACTION_BADGE[p.action]?.label || p.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.deal?.action ? (
                        <>
                          <span className="font-medium">{p.deal.action}</span>
                          {p.deal.stage_slug && <span className="text-neutral-500 ml-1">→ {p.deal.stage_slug}</span>}
                          {p.deal.to_slug && <span className="text-neutral-500 ml-1">→ {p.deal.to_slug}</span>}
                        </>
                      ) : <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-700">
                      {p.interactions
                        ? `${p.interactions.synced ?? 0} synced` + (p.interactions.errors ? ` · ${p.interactions.errors} err` : '')
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-red-700">{p.error || ''}</td>
                  </tr>
                ))}
                {(previewResult.processed || []).length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-sm text-neutral-500">No members in this batch.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent runs (cron + manual) */}
      <section className="rounded-xl border border-neutral-200 bg-white">
        <header className="px-4 py-3 border-b border-neutral-200">
          <h3 className="text-sm font-semibold">Recent automated runs (daily cron)</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            From the 03:00 UTC cron + any prior manual runs that wrote to <code className="font-mono">glofox_sync_runs</code>.
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-600">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Duration</th>
                <th className="px-3 py-2 text-right">Members</th>
                <th className="px-3 py-2 text-right">Pages</th>
                <th className="px-3 py-2">Summary</th>
                <th className="px-3 py-2">First error</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-4 text-center text-sm text-neutral-500">No runs yet.</td></tr>
              )}
              {recentRuns.map((r) => (
                <tr key={r.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2 text-xs">{new Date(r.started_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                      r.status === 'completed' ? 'bg-emerald-100 text-emerald-800 border-emerald-200' :
                      r.status === 'failed'    ? 'bg-red-100 text-red-800 border-red-200' :
                                                  'bg-amber-100 text-amber-800 border-amber-200'
                    }`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">{r.leads_processed ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">{r.pages_fetched ?? 0}</td>
                  <td className="px-3 py-2 text-[11px] font-mono text-neutral-700">
                    {r.summary
                      ? Object.entries(r.summary).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ')
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-red-700 truncate max-w-xs">{r.first_error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Tile({ label, value }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums truncate">{value}</p>
    </div>
  )
}

function addToCumulative(cum, json) {
  const next = { ...cum }
  next.pages_fetched = (next.pages_fetched || 0) + 1
  next.leads_processed = (next.leads_processed || 0) + (json.fetched || 0)
  for (const k of Object.keys(EMPTY_SUMMARY)) {
    next[k] = (next[k] || 0) + (json.summary?.[k] || 0)
  }
  return next
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return iso
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
