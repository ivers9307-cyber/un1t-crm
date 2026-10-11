'use client'
// Shows when the ads data was last synced + a manual "Refresh" that runs an
// on-demand sync (POST /api/dashboard/ads/refresh) then re-renders the page.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui'
import { formatRecordTime } from '@/lib/record-time'
import { useViewerZone } from '@/lib/use-viewer-zone'

// TZ.16 (D3 = A) — the studio's zone (`timezone`, the dashboard's location),
// abbreviation only when the browser is elsewhere.
export function fmtSynced(ts, zone, viewerZone = null) {
  if (!ts) return 'never'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return formatRecordTime(d, zone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, 'en-IE', viewerZone)
}

export default function AdsRefreshButton({ locationId, timezone = null, lastSyncedAt }) {
  const viewerZone = useViewerZone()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [syncedAt, setSyncedAt] = useState(lastSyncedAt || null)

  async function refresh() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/dashboard/ads/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ locationId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.success === false) { setError(j.error || `Refresh failed (${res.status})`); return }
      const failed = (j.results || []).find((r) => r.error)
      if (failed) setError(failed.error) // e.g. a Meta token/permission error
      setSyncedAt(j.synced_at || new Date().toISOString())
      router.refresh() // re-fetch the server component with the freshly-synced data
    } catch {
      setError('Refresh failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs whitespace-nowrap">
        {error
          ? <span className="text-red-700">{error}</span>
          : <span className="text-un1t-subtle">Last refreshed: {fmtSynced(syncedAt, timezone, viewerZone)}</span>}
      </span>
      <Button type="button" variant="secondary" size="sm" icon={RefreshCw} loading={busy} onClick={refresh}>
        {busy ? 'Refreshing…' : 'Refresh'}
      </Button>
    </div>
  )
}
