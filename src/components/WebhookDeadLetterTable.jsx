'use client'

// WebhookDeadLetterTable — interactive client half of /admin/webhook-dead-letter
// (DEADLETTER-UI.1). Lists captured events that 200'd their provider but were
// never processed: unroutable/unparseable inbound email, exhausted
// postmark_webhook_queue rows (bounces, spam complaints, RFC-8058 one-click
// unsubscribes), sent-but-unfiled ticket mail, and the older glofox/inbody
// captures.
//
// SURFACING ONLY — no auto-processing lives here. Two actions, both explicit:
//   • Replay: shown ONLY when the API says the row's provider has a
//     registered idempotent re-driver (`replayable`). The email-family
//     sources are deliberately not replayable — re-queueing an exhausted row
//     resets the retry budget that just ran out, and replaying a
//     sent-but-unfiled email IS the double-send — so those rows only ever
//     offer the human acknowledge path.
//   • Resolve / Discard: records that a human dealt with (or dismissed) the
//     event, which is what removes it from the integration-health count.
//
// The payload summary is TEXT ONLY, via summarizeDeadLetter — these payloads
// carry full message bodies, and html_body is never rendered outside the
// sanctioned sanitiser path. This table shows envelopes, never bodies.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, AlertCircle, Loader2, CheckCircle2, Trash2, RotateCcw } from 'lucide-react'
import { providerLabel, summarizeDeadLetter, discardConfirmText } from '@/lib/dead-letter-summary'

// Light-theme status chips (un1t-* palette — -700 text ramp per the
// check:guardrails no-low-contrast-chip rule).
const STATUS_CHIP = {
  pending: 'bg-amber-500/10 text-amber-700',
  failed: 'bg-red-500/10 text-red-700',
  resolved: 'bg-green-500/10 text-green-700',
  discarded: 'bg-slate-500/10 text-slate-700',
}

const TABS = [
  { key: 'open', label: 'Needs attention' },       // pending + failed
  { key: 'resolved', label: 'Resolved' },
  { key: 'discarded', label: 'Discarded' },
  { key: 'all', label: 'All' },
]

function matchesTab(row, tab) {
  if (tab === 'open') return row.status === 'pending' || row.status === 'failed'
  if (tab === 'all') return true
  return row.status === tab
}

function ago(iso) {
  if (!iso) return '—'
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 90) return 'just now'
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

export default function WebhookDeadLetterTable() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [tab, setTab] = useState('open')
  const [provider, setProvider] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/admin/webhook-dead-letter')
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRows(json.data || [])
    } catch (e) {
      setLoadError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const providers = useMemo(
    () => [...new Set(rows.map((r) => r.provider))].sort(),
    [rows]
  )
  const visible = useMemo(
    () => rows.filter((r) => matchesTab(r, tab) && (!provider || r.provider === provider)),
    [rows, tab, provider]
  )
  const openCount = useMemo(() => rows.filter((r) => matchesTab(r, 'open')).length, [rows])

  async function act(row, path, body) {
    setBusyId(row.id)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/webhook-dead-letter/${row.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setActionError(`Row ${row.id}: ${e.message || 'action failed'}`)
    } finally {
      setBusyId(null)
    }
  }

  const actionable = (row) => row.status === 'pending' || row.status === 'failed'

  // Open rows of the CURRENTLY SELECTED provider — the bulk action's exact
  // scope. It is offered only with a provider chosen, never across sources:
  // clearing a Zoom backlog must not quietly acknowledge an unread inbound
  // email too. Recovery path for the mass-park case — a provider that parks
  // per phone number can leave dozens of rows behind one credential fault, and
  // a per-row-only un-park would mean dozens of clicks right after the
  // operator fixed the single cause.
  const bulkOpenCount = useMemo(
    () => (provider ? rows.filter((r) => r.provider === provider && matchesTab(r, 'open')).length : 0),
    [rows, provider]
  )

  async function bulkResolve() {
    setBusyId('bulk')
    setActionError(null)
    try {
      const res = await fetch('/api/admin/webhook-dead-letter/bulk-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, status: 'resolved' }),
      })
      const json = await res.json()
      if (!res.ok || json.success === false) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setActionError(`Bulk resolve: ${e.message || 'action failed'}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-lg border border-un1t-border overflow-hidden">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-xs font-medium ${
                tab === t.key ? 'bg-un1t-border/40 text-un1t-text' : 'bg-un1t-surface text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {t.label}{t.key === 'open' && openCount > 0 ? ` (${openCount})` : ''}
            </button>
          ))}
        </div>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="text-xs border border-un1t-border rounded-lg px-2 py-1.5 bg-un1t-surface text-un1t-text"
        >
          <option value="">All sources</option>
          {providers.map((p) => (
            <option key={p} value={p}>{providerLabel(p)}</option>
          ))}
        </select>
        {bulkOpenCount > 0 ? (
          <button
            type="button"
            disabled={busyId === 'bulk'}
            onClick={() => {
              if (confirm(
                `Mark all ${bulkOpenCount} open ${providerLabel(provider)} rows as resolved? `
                + 'Use this after fixing the one underlying cause — it acknowledges every row '
                + 'for this source, so anything still genuinely broken will simply come back.'
              )) bulkResolve()
            }}
            className="flex items-center gap-1 text-xs font-medium text-green-700 border border-un1t-border rounded-lg px-2.5 py-1.5 hover:bg-green-500/10 disabled:opacity-50"
          >
            {busyId === 'bulk'
              ? <Loader2 size={13} className="animate-spin" />
              : <CheckCircle2 size={13} />} Resolve all {bulkOpenCount}
          </button>
        ) : null}
        <button
          type="button"
          onClick={load}
          className="ml-auto flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1.5"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {actionError ? (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-500/10 rounded-lg px-3 py-2 mb-3">
          <AlertCircle size={14} className="shrink-0" /> {actionError}
        </div>
      ) : null}

      {/* List */}
      <div className="rounded-lg border border-un1t-border overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-un1t-subtle">
            <Loader2 size={16} className="animate-spin inline mr-2" /> Loading…
          </div>
        ) : loadError ? (
          <div className="p-8 text-center text-sm text-red-700">{loadError}</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-un1t-subtle">
            {tab === 'open' ? 'Nothing needs attention — the dead-letter queue is clear.' : 'No rows.'}
          </div>
        ) : (
          visible.map((row) => {
            const summary = summarizeDeadLetter(row)
            const busy = busyId === row.id
            return (
              <div key={row.id} className="px-4 py-3 border-b border-un1t-border last:border-b-0 bg-un1t-surface">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-un1t-text">{providerLabel(row.provider)}</span>
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${STATUS_CHIP[row.status] || STATUS_CHIP.discarded}`}>
                        {row.status}
                      </span>
                      <span className="text-xs text-un1t-muted">#{row.id}</span>
                    </div>
                    {summary ? (
                      <div className="text-xs text-un1t-subtle mt-1 break-words">{summary}</div>
                    ) : null}
                    {row.error ? (
                      <div className="text-xs text-un1t-muted mt-1 break-words">{String(row.error).slice(0, 300)}</div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs text-un1t-subtle">{ago(row.received_at)}</div>
                    <div className="text-[11px] text-un1t-muted mt-0.5">
                      {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
                {actionable(row) ? (
                  <div className="flex items-center gap-2 mt-2">
                    {row.replayable ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act(row, 'replay')}
                        className="flex items-center gap-1 text-xs font-medium text-un1t-text border border-un1t-border rounded-lg px-2.5 py-1 hover:bg-un1t-border/30 disabled:opacity-50"
                      >
                        <RotateCcw size={12} /> Replay
                      </button>
                    ) : (
                      <span className="text-[11px] text-un1t-muted">Not auto-replayable — handle by hand, then resolve.</span>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act(row, 'resolve', { status: 'resolved' })}
                      className="flex items-center gap-1 text-xs font-medium text-green-700 border border-un1t-border rounded-lg px-2.5 py-1 hover:bg-green-500/10 disabled:opacity-50"
                    >
                      <CheckCircle2 size={12} /> Mark resolved
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(discardConfirmText(row.provider))) {
                          act(row, 'resolve', { status: 'discarded' })
                        }
                      }}
                      className="flex items-center gap-1 text-xs font-medium text-un1t-subtle border border-un1t-border rounded-lg px-2.5 py-1 hover:bg-un1t-border/30 disabled:opacity-50"
                    >
                      <Trash2 size={12} /> Discard
                    </button>
                    {busy ? <Loader2 size={13} className="animate-spin text-un1t-muted" /> : null}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <p className="text-xs text-un1t-muted mt-3">
        Newest 200 rows. Payloads are summarised — addresses, subjects and event names only; message bodies are never shown here.
      </p>
    </div>
  )
}
