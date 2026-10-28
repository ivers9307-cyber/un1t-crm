'use client'

// un1t.online integration tab (UN1TSYNC.7) — Hatch Street's gym platform.
//
// Talks only to /api/locations/[id]/un1t-online (GET status, PUT connect,
// DELETE disconnect) and .../sync (POST, "Sync now"). All three are
// owner/master at this studio, service-role, and masked: the token is typed
// into a write-only password field, posted, and cleared; no response carries
// it back, so nothing here can render it.
//
// The sync only READS from un1t.online. Writes (booking, cancelling, the
// trial, accounts) are off until a master switches them on in the Writes
// section (UN1TWRITE.12, masters only: the GET carries `write` only for them).
// While writes are off, a token that can change data is flagged, because a
// read-only one is safer; with writes on, the token needs those permissions.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, RefreshCw, Unplug, PlugZap } from 'lucide-react'
import { DEFAULT_APP_SECTION_COPY } from '@/lib/un1t-online-app-links'

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
    // The connect answer has no write block; keep what the tab already shows.
    setState((s) => ({ loading: false, data: { ...r.json.data, write: s.data?.write, writes_enabled: s.data?.writes_enabled }, error: null }))
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

  // Write-setting saves run one after another (each is a read-modify-write
  // of the studio's settings) and never disable the controls, so a click made
  // while an earlier save is in flight is queued, not lost.
  const saveChain = useRef(Promise.resolve())
  function saveWrite(patch) {
    saveChain.current = saveChain.current.then(() => doSaveWrite(patch)).catch(() => {})
    return saveChain.current
  }
  async function doSaveWrite(patch) {
    setError(null); setNotice(null)
    const r = await call(() => fetch(`/api/locations/${location.id}/un1t-online`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }))
    if (!r.ok) { setError(r.error); return }
    setState((s) => {
      const next = { ...(s.data?.write || {}), ...(r.json.data?.write || {}) }
      return { ...s, data: { ...s.data, write: next, writes_enabled: !!next.writes_enabled } }
    })
    setNotice('Saved.')
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
  const write = data?.write && !data.write.unreadable ? data.write : null

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
          {data.has_write_permissions && !data.writes_enabled && !write?.writes_enabled && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-xs rounded-md p-2">
              This token can change data on un1t.online. The CRM only reads, so a read-only token is safer: create one with the Read-only preset and paste it here.
            </div>
          )}
        </div>
      )}

      {write && (
        <div data-testid="un1t-writes" className="border border-un1t-border rounded-md p-3 space-y-2 text-xs">
          <div className="text-sm font-semibold text-un1t-text">Writes</div>
          <label className="flex items-center gap-2 text-un1t-text">
            <input
              type="checkbox"
              checked={!!write.writes_enabled}
              onChange={(e) => saveWrite({ writes_enabled: e.target.checked })}
            />
            Allow the CRM to write to un1t.online
          </label>
          <div className="space-y-1">
            <label htmlFor="un1t-trial-product" className="block text-un1t-subtle">Trial product</label>
            <select
              id="un1t-trial-product"
              value={write.trial_product_id || ''}
              onChange={(e) => saveWrite({ trial_product_id: e.target.value || null })}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text"
            >
              <option value="">Not set</option>
              {(write.trial_products || []).map((p) => <option key={p.un1t_id} value={p.un1t_id}>{p.title}</option>)}
            </select>
            <div className="text-un1t-subtle">Only active, free, one-time products are listed.</div>
          </div>
          <label className="flex items-center gap-2 text-un1t-text">
            <input
              type="checkbox"
              checked={!!write.funnel_enabled}
              disabled={!write.writes_enabled}
              onChange={(e) => saveWrite({ funnel_enabled: e.target.checked })}
            />
            Take new people through un1t.online
          </label>
          <div className="text-un1t-subtle">
            {write.writes_enabled
              ? 'The website class form and the WhatsApp booking flow create the account, give the free trial and book the class in un1t.online.'
              : 'Turn writes on first.'}
          </div>
          <div className="space-y-1">
            <label htmlFor="un1t-hidden-keywords" className="block text-un1t-subtle">Classes to hide from new people</label>
            <textarea
              id="un1t-hidden-keywords"
              rows={2}
              key={write.hidden_class_keywords || ''}
              defaultValue={write.hidden_class_keywords || ''}
              onBlur={(e) => { if (e.target.value !== (write.hidden_class_keywords || '')) saveWrite({ hidden_class_keywords: e.target.value }) }}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text"
            />
            <div className="text-un1t-subtle">Words separated by commas. A class whose name contains one is not offered to new people.</div>
          </div>
          <div className="space-y-2">
            <div className="text-un1t-text font-medium">App download links in the emails</div>
            {[
              ['ios_url', 'App Store link', 'https://apps.apple.com/...', 'input'],
              ['android_url', 'Google Play link', 'https://play.google.com/...', 'input'],
              ['heading', 'App section heading', DEFAULT_APP_SECTION_COPY.heading, 'input'],
              ['body', 'App section text', DEFAULT_APP_SECTION_COPY.body, 'textarea'],
            ].map(([key, label, placeholder, kind]) => {
              const stored = write.app_links?.[key] || ''
              const props = {
                id: `un1t-app-${key}`,
                defaultValue: stored,
                placeholder,
                onBlur: (e) => {
                  const v = e.target.value.trim()
                  if (v !== stored) saveWrite({ app_links: { [key]: v === '' ? null : v } })
                },
                className: 'w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text',
              }
              return (
                <div key={key} className="space-y-1">
                  <label htmlFor={props.id} className="block text-un1t-subtle">{label}</label>
                  {kind === 'textarea'
                    ? <textarea key={`${key}:${stored}`} rows={3} {...props} />
                    : <input key={`${key}:${stored}`} type="url" {...props} />}
                </div>
              )
            })}
            <div className="text-un1t-subtle">Links must start with https://. With no link, the emails leave the app section out.</div>
          </div>
          {[
            ['un1t_sends_welcome', 'un1t.online sends its own welcome email', 'Then the CRM does not send its account email.'],
            ['un1t_welcome_sets_login', 'That welcome email lets them set a password', 'Then the CRM does not ask un1t.online for a set-password code either.'],
            ['un1t_sends_booking_confirmation', 'un1t.online confirms bookings itself', 'Then the CRM does not send its booking confirmation.'],
          ].map(([key, label, hint]) => (
            <div key={key}>
              <label className="flex items-center gap-2 text-un1t-text">
                <input type="checkbox" checked={!!write[key]} disabled={key === 'un1t_welcome_sets_login' && !write.un1t_sends_welcome} onChange={(e) => saveWrite({ [key]: e.target.checked })} />
                {label}
              </label>
              <div className="text-un1t-subtle pl-6">{hint}</div>
            </div>
          ))}
          <div className={write.permissions?.all_present ? 'text-green-700' : 'text-amber-700'}>
            {write.permissions?.unreadable
              ? 'Write permissions could not be checked just now.'
              : write.permissions?.not_connected
                ? 'Connect a token first.'
                : write.permissions?.wrong_studio
                  ? 'This token is for a different un1t.online studio.'
                  : write.permissions?.all_present
                ? 'Write permissions: all present'
                : `Write permissions missing: ${(write.permissions?.missing || []).join(', ')}`}
          </div>
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
