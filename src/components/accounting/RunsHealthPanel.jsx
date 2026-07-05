// RCOV.P2 — the Runs & health tab: heartbeat status for the two
// receipt-coverage crons, hunt-inbox health, recent run history, and
// the week's LLM spend against the $15 hunt budget.
'use client'

import { useEffect, useState } from 'react'
import { Card, Loading } from '@/components/ui'

const HB_LABEL = {
  'receipt-coverage-weekly': 'Weekly cycle (pull → hunt → report)',
  'process-receipt-hunts': 'Hunt drain (every 5 min)',
}

const TRIGGER_LABEL = { cron: 'Friday pull', manual: 'Manual pull', report: 'Weekly report' }

const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-IE') : '—')

function durationLabel(startIso, endIso) {
  if (!startIso || !endIso) return '—'
  const s = Math.round((new Date(endIso) - new Date(startIso)) / 1000)
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`
}

export default function RunsHealthPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await fetch('/api/accounting/health')
      const json = await res.json().catch(() => ({}))
      if (cancelled) return
      if (!json.success) setError(json.error || 'Failed to load health data')
      else setData(json.data)
    })()
    return () => { cancelled = true }
  }, [])

  if (error) return <div className="text-sm px-3 py-2 rounded bg-red-500/10 text-red-700">{error}</div>
  if (!data) return <Loading />

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-semibold text-un1t-text mb-3">Heartbeats</h3>
        <div className="space-y-2">
          {data.heartbeats.map((h) => (
            <div key={h.name} className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-un1t-text">{HB_LABEL[h.name] || h.name}</div>
                <div className="text-xs text-un1t-subtle">Last healthy: {dt(h.last_ok_at)}</div>
              </div>
              <span className={`text-xs px-2 py-1 rounded ${h.stale ? 'bg-red-500/10 text-red-700' : 'bg-green-500/10 text-green-700'}`}>
                {h.stale ? 'Stale' : 'Healthy'}
              </span>
            </div>
          ))}
          {data.heartbeats.length === 0 ? (
            <p className="text-xs text-un1t-subtle">No heartbeat rows found.</p>
          ) : null}
        </div>
        <p className="text-xs text-un1t-subtle mt-3">
          The weekly heartbeat only stamps on a fully clean cycle (no pull errors, no anomalies, report emailed) —
          stale after Friday means something needs a look, starting with the runs below.
        </p>
      </Card>

      <Card>
        <h3 className="text-sm font-semibold text-un1t-text mb-3">Hunt inboxes</h3>
        <div className="space-y-2">
          {data.mailboxes.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-un1t-text">{m.label}</div>
                <div className="text-xs text-un1t-subtle">{m.email}</div>
              </div>
              {m.last_error ? (
                <span className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-700" title={m.last_error}>
                  Auth failed
                </span>
              ) : m.active ? (
                <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-700">Connected</span>
              ) : (
                <span className="text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-700">Inactive</span>
              )}
            </div>
          ))}
          {data.mailboxes.length === 0 ? (
            <p className="text-xs text-un1t-subtle">No inboxes added yet — use the Hunt inboxes card above.</p>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-un1t-text">Recent runs</h3>
          <span className="text-xs text-un1t-subtle">
            LLM spend, last 7 days: ${data.spend7dUsd.toFixed(2)} of $15 budget
          </span>
        </div>
        {data.runs.length === 0 ? (
          <p className="text-xs text-un1t-subtle">No runs yet — the first Friday cycle (or a manual refresh) will appear here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-un1t-subtle border-b border-un1t-border">
                  <th className="py-1.5 pr-4 font-medium">Run</th>
                  <th className="py-1.5 pr-4 font-medium">Status</th>
                  <th className="py-1.5 pr-4 font-medium">Started</th>
                  <th className="py-1.5 pr-4 font-medium">Duration</th>
                  <th className="py-1.5 pr-4 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id} className="border-b border-un1t-border/50">
                    <td className="py-2 pr-4 text-un1t-text">
                      {TRIGGER_LABEL[r.trigger] || r.trigger}
                      {r.forced ? <span className="ml-1 text-xs text-amber-700">(forced)</span> : null}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs px-2 py-1 rounded ${
                        r.status === 'ok' ? 'bg-green-500/10 text-green-700'
                        : r.status === 'running' ? 'bg-blue-500/10 text-blue-700'
                        : 'bg-red-500/10 text-red-700'
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-xs text-un1t-subtle">{dt(r.started_at)}</td>
                    <td className="py-2 pr-4 text-xs text-un1t-subtle">{durationLabel(r.started_at, r.finished_at)}</td>
                    <td className="py-2 pr-4 text-xs text-un1t-subtle" title={r.error || ''}>
                      {r.anomalies > 0 ? `${r.anomalies} anomal${r.anomalies === 1 ? 'y' : 'ies'} · ` : ''}
                      {r.error ? `${r.error.slice(0, 80)}${r.error.length > 80 ? '…' : ''}` : r.accounts != null ? `${r.accounts} account(s)` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
