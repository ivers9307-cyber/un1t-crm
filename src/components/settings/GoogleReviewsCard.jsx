'use client'

// Per-location Google Business reviews card (Settings → Locations →
// Integrations). Connect/disconnect mirror XeroLocationCard; adds a GBP
// location picker, a "Sync now" button, and the per-review hide toggles
// that drive the landing-page carousel.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Plug, RefreshCw, Unlink, Star, EyeOff, Eye } from 'lucide-react'

export default function GoogleReviewsCard({ location, connection }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [reviews, setReviews] = useState([])
  const [locs, setLocs] = useState([])     // GBP locations to pick from
  const [pickBusy, setPickBusy] = useState(false)

  const connected = !!connection
  const locationSelected = !!connection?.location_resource

  const onConnect = () => { window.location.href = `/api/google-business/connect?location_id=${location.id}` }

  const onDisconnect = async () => {
    if (!confirm(`Disconnect Google reviews from ${location.name}?`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/google-business/disconnect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id }),
      })
      const j = await res.json()
      if (!j.success) alert(j.error || 'Disconnect failed')
      router.refresh()
    } finally { setBusy(false) }
  }

  const loadReviews = useCallback(async () => {
    if (!connected) return
    const res = await fetch(`/api/google-reviews?location_id=${location.id}`).catch(() => null)
    if (!res) return
    const j = await res.json().catch(() => ({}))
    if (j.success) setReviews(j.data || [])
  }, [connected, location.id])

  useEffect(() => { loadReviews() }, [loadReviews])

  const onSync = async () => {
    setSyncing(true); setSyncResult(null)
    try {
      const res = await fetch('/api/google-business/sync-now', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id }),
      })
      const j = await res.json()
      setSyncResult(j.success ? { ok: j.data } : { error: j.error || 'Sync failed' })
      if (j.success) { await loadReviews(); router.refresh() }
    } catch (e) {
      setSyncResult({ error: e.message || 'Network error' })
    } finally { setSyncing(false) }
  }

  const toggleHide = async (rev) => {
    const res = await fetch(`/api/google-reviews/${rev.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: !rev.hidden }),
    })
    const j = await res.json()
    if (j.success) setReviews((rs) => rs.map((r) => (r.id === rev.id ? { ...r, hidden: j.data.hidden } : r)))
    else alert(j.error || 'Update failed')
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-un1t-text">Google reviews — {location.name}</div>
          {connected ? (
            <div className="text-xs text-un1t-subtle mt-1 space-y-0.5">
              <div>Listing: <span className="text-un1t-text">{connection.location_title || (locationSelected ? connection.location_resource : 'not selected')}</span></div>
              <div className="text-un1t-muted">
                {connection.average_rating != null && <>{connection.average_rating}★ · {connection.total_review_count} reviews · </>}
                last synced {connection.last_synced_at ? new Date(connection.last_synced_at).toLocaleString() : 'never'}
              </div>
              {connection.sync_error && <div className="text-red-700">{connection.sync_error}</div>}
            </div>
          ) : (
            <div className="text-xs text-un1t-subtle mt-1">Not connected.</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {connected ? (
            <>
              {locationSelected && (
                <button onClick={onSync} disabled={syncing}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded-md disabled:opacity-50">
                  <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              )}
              <button onClick={onConnect} disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded-md disabled:opacity-50">
                <RefreshCw size={12} /> Reconnect
              </button>
              <button onClick={onDisconnect} disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-red-500/40 hover:bg-red-500/10 text-red-700 rounded-md disabled:opacity-50">
                <Unlink size={12} /> Disconnect
              </button>
            </>
          ) : (
            <button onClick={onConnect} disabled={busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-text text-un1t-bg rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50">
              <Plug size={12} /> Connect Google
            </button>
          )}
        </div>
      </div>

      {/* Location picker — shown when connected but no GBP location selected. */}
      {connected && !locationSelected && (
        <LocationPicker
          locationId={location.id}
          locs={locs}
          setLocs={setLocs}
          busy={pickBusy}
          setBusy={setPickBusy}
          onPicked={() => router.refresh()}
        />
      )}

      {syncResult?.error && <div className="mt-2 text-[11px] text-red-700">{syncResult.error}</div>}
      {syncResult?.ok && <div className="mt-2 text-[11px] text-emerald-700">Synced {syncResult.ok.synced} reviews.</div>}

      {/* Hide list */}
      {connected && locationSelected && reviews.length > 0 && (
        <div className="mt-4 pt-3 border-t border-un1t-border/50">
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">
            Synced reviews — hide any you don&apos;t want on the landing page
          </div>
          <ul className="space-y-1.5 max-h-80 overflow-auto">
            {reviews.map((r) => (
              <li key={r.id} className={`flex items-start gap-2 text-xs p-2 rounded ${r.hidden ? 'opacity-50 bg-un1t-bg/20' : 'bg-un1t-bg/30'}`}>
                <span className="text-amber-600 shrink-0 inline-flex items-center"><Star size={11} className="fill-amber-500 stroke-amber-500" />{r.rating}</span>
                <span className="flex-1 text-un1t-text">
                  <span className="font-medium">{r.author_name || 'Google user'}:</span>{' '}
                  <span className="text-un1t-subtle">{r.comment || <em>(no text)</em>}</span>
                </span>
                <button type="button" onClick={() => toggleHide(r)} className="shrink-0 text-un1t-muted hover:text-un1t-text" title={r.hidden ? 'Show' : 'Hide'}>
                  {r.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function LocationPicker({ locationId, locs, setLocs, busy, setBusy, onPicked }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    fetch(`/api/google-business/locations?location_id=${locationId}`)
      .then((r) => r.json()).then((j) => { if (j.success) setLocs(j.data || []) })
      .finally(() => setLoaded(true))
  }, [locationId, setLocs])

  const pick = async (l) => {
    setBusy(true)
    try {
      const res = await fetch('/api/google-business/select-location', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, location_resource: l.resource, location_title: l.title }),
      })
      const j = await res.json()
      if (!j.success) { alert(j.error || 'Failed'); return }
      onPicked()
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-3 pt-3 border-t border-un1t-border/50">
      <div className="text-xs text-un1t-subtle mb-2">Pick which Google listing maps to this studio:</div>
      {!loaded ? <div className="text-[11px] text-un1t-muted">Loading…</div> : (
        <div className="flex flex-wrap gap-2">
          {locs.length === 0 && <div className="text-[11px] text-un1t-muted">No listings found on this Google account.</div>}
          {locs.map((l) => (
            <button type="button" key={l.resource} disabled={busy} onClick={() => pick(l)}
              className="text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border rounded-md disabled:opacity-50">
              {l.title || l.resource}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
