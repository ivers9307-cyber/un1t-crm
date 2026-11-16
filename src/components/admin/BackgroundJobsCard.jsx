'use client'

// STALEWATCH.1 — the Background jobs card on /admin/health: every global job
// heartbeat that is stale or acknowledged, with Acknowledge / Clear. The
// healthy rest are counted, not listed. Master only (the page and both routes
// gate on it).

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui'

function age(seconds) {
  const s = Number(seconds) || 0
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 172800) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export default function BackgroundJobsCard() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/cron-health', { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not load the jobs.')
      setRows(body.data)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function acknowledge(name) {
    const note = typeof window !== 'undefined' ? window.prompt(`Acknowledge ${name} for 7 days. Note (who is on it, or why)?`, '') : ''
    if (note === null) return
    setBusy(name)
    try {
      const res = await fetch(`/api/admin/cron-health/${encodeURIComponent(name)}/acknowledge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours: 168, note }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) setError(body.error || 'Could not acknowledge the job.')
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function clear(name) {
    setBusy(name)
    try {
      const res = await fetch(`/api/admin/cron-health/${encodeURIComponent(name)}/acknowledge`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) setError(body.error || 'Could not clear the acknowledgement.')
      await load()
    } finally {
      setBusy(null)
    }
  }

  const shown = (rows || []).filter((r) => r.is_stale || r.is_acknowledged)
  const healthy = (rows || []).length - shown.length

  return (
    <div className="mb-8 rounded-lg border border-un1t-border bg-un1t-surface p-4" data-testid="background-jobs">
      <h2 className="text-lg font-semibold">Background jobs</h2>
      <p className="text-sm text-un1t-subtle mb-3">
        A job that stops succeeding alerts the masters once, then appears in a daily digest until it recovers.
        Acknowledge a known fault to stop it alerting and holding the health check red; the acknowledgement runs out after 7 days.
      </p>
      {error && <p role="alert" className="mb-2 text-sm text-rose-700">{error}</p>}
      {rows === null && !error && <p className="text-sm text-un1t-subtle">Loading…</p>}
      {rows !== null && (
        <>
          {shown.length === 0 ? (
            <p className="text-sm text-emerald-700">All {healthy} jobs are running.</p>
          ) : (
            <ul className="divide-y divide-un1t-border">
              {shown.map((r) => (
                <li key={r.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="text-sm">
                    <span className="font-medium text-un1t-text">{r.name}</span>{' '}
                    {r.is_stale
                      ? <span className="rounded-full px-2 py-0.5 text-xs bg-red-500/10 text-red-700">stale {age(r.stale_seconds)}</span>
                      : <span className="rounded-full px-2 py-0.5 text-xs bg-green-500/10 text-green-700">running</span>}
                    {r.is_acknowledged && (
                      <span className="ml-1 rounded-full px-2 py-0.5 text-xs bg-gray-500/10 text-gray-700">
                        acknowledged until {String(r.acknowledged_until).slice(0, 10)}{r.acknowledged_note ? `: ${r.acknowledged_note}` : ''}
                      </span>
                    )}
                  </div>
                  {r.is_acknowledged
                    ? <Button type="button" variant="secondary" size="sm" loading={busy === r.name} disabled={busy !== null} onClick={() => clear(r.name)}>Clear</Button>
                    : <Button type="button" variant="secondary" size="sm" loading={busy === r.name} disabled={busy !== null} onClick={() => acknowledge(r.name)}>Acknowledge 7 days</Button>}
                </li>
              ))}
            </ul>
          )}
          {shown.length > 0 && <p className="mt-2 text-xs text-un1t-subtle">{healthy} other jobs running.</p>}
        </>
      )}
    </div>
  )
}
