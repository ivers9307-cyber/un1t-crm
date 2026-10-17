'use client'

// un1t.online integration tab (UN1TSYNC.7) — Hatch Street's gym platform.
//
// Talks only to /api/locations/[id]/un1t-online (GET status, PUT connect,
// DELETE disconnect) and .../sync (POST, "Sync now"). All three are
// owner/master at this studio, service-role, and masked: the token is typed
// into a write-only password field, posted, and cleared; no response carries
// it back, so nothing here can render it.
//
// The CRM only READS from un1t.online. A token that can change data is allowed
// (some presets are broader) but flagged, because a read-only one is safer.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, RefreshCw, Unplug, PlugZap } from 'lucide-react'

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRY_WARN_DAYS = 30

const UNKNOWN_CHIP = { label: 'Unknown', tone: 'bg-un1t-border/40 text-un1t-subtle' }
const SOURCE_NOT_SET_NOTE = 'Connected, but this studio\'s membership source was not switched to un1t.online. Set it on the Membership source card.'

const STATUS_CHIP = {
  connected: { label: 'Connected', tone: 'bg-green-500/10 text-green-700' },
  action_needed: { label: 'Action needed', tone: 'bg-amber-500/10 text-amber-700' },
  error: { label: 'Error', tone: 'bg-red-500/10 text-red-700' },
}

// `zone` is the studio's own IANA zone when the page supplies it; otherwise the
// browser's, never a hard-coded one.
function formatWhen(iso, zone) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('en-IE', { timeZone: zone || undefined, dateStyle: 'medium', timeStyle: 'short' })
}

function describeExpiry(expiresAt, nowMs, zone) {
  if (!expiresAt) return { text: 'No expiry', expiring: false, expired: false }
  const ms = new Date(expiresAt).getTime()
  if (Number.isNaN(ms)) return { text: 'Expiry unknown', expiring: false, expired: false }
  const when = formatWhen(expiresAt, zone)
  const days = Math.ceil((ms - nowMs) / DAY_MS)
  if (days <= 0) return { text: `Expired ${when}`, expiring: true, expired: true }
  const left = days === 1 ? '1 day left' : `${days} days left`
  return { text: `Expires ${when} (${left})`, expiring: days <= EXPIRY_WARN_DAYS, expired: false }
}

function describeCounts(counts) {
  const pulled = counts?.pulled
  if (!pulled || typeof pulled !== 'object') return null
  const parts = Object.entries(pulled).map(([name, n]) => `${name} ${n}`)
  return parts.length ? parts.join(', ') : null
}

// Contact matching, from the run's counts: how many members became contacts
// and how many could not be matched (those need a human).
function describeContacts(counts) {
  const c = counts?.contacts
  if (!c || typeof c !== 'object') return null
  const n = (v) => (Number.isFinite(v) ? v : 0)
  return `${n(c.created)} created, ${n(c.attached_by_email)} attached, ${n(c.failed)} failed, ${n(c.conflict)} conflicts, ${n(c.ambiguous_email)} ambiguous emails`
}

export default function Un1tOnlineIntegrationTab({ location, canEdit }) {
  const router = useRouter()

  const [state, setState] = useState({ loading: true, data: null, error: null })
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(null) // 'connect' | 'sync' | 'disconnect'
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  // PUT said the connect saved but membership_source did not move to un1t_online.
  const [sourceNotSet, setSourceNotSet] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/locations/${location.id}/un1t-online`)
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        setState({ loading: false, data: null, error: json?.error || `Could not load (${res.status})` })
        return
      }
      setState({ loading: false, data: json.data, error: null })
    } catch (e) {
      setState({ loading: false, data: null, error: `Could not load: ${e?.message || 'network error'}` })
    }
  }, [location.id])

  useEffect(() => { load() }, [load])

  // `send` makes the request; each fetch below names its /api/locations/${id}
  // path literally (tests/location-settings-target.test.js scans for that).
  async function call(send) {
    let res
    let json = null
    try {
      res = await send()
      json = await res.json().catch(() => null)
    } catch (e) {
      return { ok: false, error: `Request failed: ${e?.message || 'network error'}` }
    }
    if (!res.ok || !json?.success) return { ok: false, error: json?.issues?.[0]?.message || json?.message || json?.error || `Request failed (${res.status})` }
    return { ok: true, json }
  }

  async function connect(e) {
    e.preventDefault()
    const value = token.trim()
    if (!value) { setError('Paste the API token from un1t.online first.'); return }
    setBusy('connect'); setError(null); setNotice(null)
    const r = await call(() => fetch(`/api/locations/${location.id}/un1t-online`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
    }))
    setBusy(null)
    if (!r.ok) { setError(r.error); return }
    setToken('')
    setSourceNotSet(r.json.data?.membership_source_set === false)
    setState({ loading: false, data: r.json.data, error: null })
    setNotice('Connected.')
    router.refresh()
  }

  async function syncNow() {
    setBusy('sync'); setError(null); setNotice(null)
    const r = await call(() => fetch(`/api/locations/${location.id}/un1t-online/sync`, { method: 'POST' }))
    if (!r.ok) { setBusy(null); setError(r.error); return }
    const result = r.json.data || {}
    if (result.ok) setNotice('Sync finished.')
    else if (result.reason === 'in_progress') setNotice('A sync is already running for this studio. It will finish in a moment.')
    else setError(`Sync failed (${result.reason || 'unknown'}).`)
    await load()
    setBusy(null)
    router.refresh()
  }

  async function disconnect() {
    if (!window.confirm('Disconnect un1t.online? The token is deleted and the sync stops. Existing data stays.')) return
    setBusy('disconnect'); setError(null); setNotice(null)
    const r = await call(() => fetch(`/api/locations/${location.id}/un1t-online`, { method: 'DELETE' }))
    setBusy(null)
    if (!r.ok) { setError(r.error); return }
    setSourceNotSet(false)
    setState({ loading: false, data: { connected: false, status: 'not_connected', last_run: null }, error: null })
    router.refresh()
  }

  const { loading, data } = state
  if (loading) {
    return <div className="text-xs text-un1t-subtle inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading…</div>
  }

  const connected = !!data?.connected
  const chip = STATUS_CHIP[data?.status] || (data?.status ? { ...UNKNOWN_CHIP, label: data.status } : UNKNOWN_CHIP)
  const expiry = connected ? describeExpiry(data.expires_at, Date.now(), location.timezone) : null
  const run = data?.last_run || null
  const runCounts = describeCounts(run?.counts)
  const contactCounts = describeContacts(run?.counts)
  const shownError = error || state.error

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Syncs members, subscriptions, payments and bookings from un1t.online every 15 minutes.
        Create an API token there (Settings, API tokens) with the Read-only preset and paste it below.
      </p>

      {shownError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> <span>{shownError}</span>
        </div>
      )}
      {sourceNotSet && connected && (
        <div role="status" className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-xs rounded-md p-2">{SOURCE_NOT_SET_NOTE}</div>
      )}
      {notice && !shownError && (
        <div role="status" className="bg-green-500/10 border border-green-500/30 text-green-700 text-xs rounded-md p-2">{notice}</div>
      )}

      {connected && (
        <div className="border border-un1t-border rounded-md p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-un1t-text">{data.studio_title}</div>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${chip.tone}`}>{chip.label}</span>
          </div>
          <div className="text-xs text-un1t-subtle">
            Token: {data.token_name || 'unnamed'} · {data.permissions_count} {data.permissions_count === 1 ? 'permission' : 'permissions'}
          </div>
          <div
            data-testid="un1t-expiry"
            data-expiring={expiry.expiring ? 'true' : 'false'}
            className={expiry.expiring ? 'text-xs font-medium text-amber-700' : 'text-xs text-un1t-subtle'}
          >
            {expiry.text}
          </div>
          {data.last_error && (
            <div className="text-xs text-red-700">Last error: {data.last_error}</div>
          )}
          {data.has_write_permissions && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-xs rounded-md p-2">
              This token can change data on un1t.online. The CRM only reads, so a read-only token is safer: create one with the Read-only preset and paste it here.
            </div>
          )}
        </div>
      )}

      {run && (
        <div data-testid="un1t-last-run" className="border border-un1t-border rounded-md p-3 text-xs space-y-1">
          <div className="text-un1t-text font-medium">
            Last sync: {formatWhen(run.started_at, location.timezone) || 'unknown time'} ·{' '}
            <span className={run.status === 'ok' ? 'text-green-700' : run.status === 'error' ? 'text-red-700' : 'text-amber-700'}>
              {run.status}
            </span>
          </div>
          {runCounts && <div className="text-un1t-subtle">Pulled: {runCounts}</div>}
          {contactCounts && <div data-testid="un1t-contact-counts" className="text-un1t-subtle">Contacts: {contactCounts}</div>}
          {run.first_error && <div className="text-red-700">{run.first_error}</div>}
        </div>
      )}

      {canEdit ? (
        <form onSubmit={connect} className="space-y-2">
          <label htmlFor="un1t-online-token" className="block text-xs text-un1t-subtle">API token</label>
          <input
            id="un1t-online-token"
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={connected ? 'Saved (hidden). Paste a new token to replace it.' : 'un1t_…'}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text"
          />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {busy === 'connect' ? <><Loader2 size={12} className="animate-spin" /> Connecting…</> : <><PlugZap size={12} /> Connect</>}
            </button>
            {connected && (
              <>
                <button
                  type="button"
                  onClick={syncNow}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-un1t-border text-sm font-semibold text-un1t-text hover:bg-un1t-border/30 disabled:opacity-50"
                >
                  {busy === 'sync' ? <><Loader2 size={12} className="animate-spin" /> Syncing…</> : <><RefreshCw size={12} /> Sync now</>}
                </button>
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-red-500/30 text-sm font-semibold text-red-700 hover:bg-red-500/10 disabled:opacity-50"
                >
                  <Unplug size={12} /> Disconnect
                </button>
              </>
            )}
          </div>
        </form>
      ) : (
        !connected && <div className="text-xs text-un1t-subtle">Not connected. Only owners can connect un1t.online.</div>
      )}
    </div>
  )
}
