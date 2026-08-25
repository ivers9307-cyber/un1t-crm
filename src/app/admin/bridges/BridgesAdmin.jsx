'use client'

// HR bridge management — register a champ-bridge (Raspberry Pi),
// see its live status, and rotate its token. Talks to the existing
// /api/admin/bridges routes (master-only).
//
// The bearer token is shown exactly once — on create or rotate. We
// surface it in a prominent, copyable panel with a ready-to-paste
// .env snippet so the operator can drop it straight onto the Pi.

import { useEffect, useState } from 'react'
import { Radio, Plus, KeyRound, Copy, Check } from 'lucide-react'

const STATUS_STYLES = {
  online: 'bg-green-100 text-green-700',
  offline: 'bg-un1t-border text-un1t-subtle',
  error: 'bg-red-100 text-red-700',
}

export default function BridgesAdmin({ locations }) {
  const [bridges, setBridges] = useState(null)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  // One-time token reveal: { token, bridge, kind: 'created'|'rotated' }.
  const [reveal, setReveal] = useState(null)
  const [rotatingId, setRotatingId] = useState(null)

  const locationName = (id) => locations.find((l) => l.id === id)?.name || '—'

  async function load() {
    setError(null)
    try {
      const res = await fetch('/api/admin/bridges', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to load bridges')
      setBridges(data.bridges || [])
    } catch (e) {
      setError(e.message)
      setBridges([])
    }
  }

  useEffect(() => { load() }, [])

  async function handleRegister(input) {
    const res = await fetch('/api/admin/bridges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to register bridge')
    setAdding(false)
    setReveal({ token: data.token, bridge: data.bridge, kind: 'created' })
    await load()
  }

  async function handleRotate(bridge) {
    if (!confirm(
      `Rotate the token for "${bridge.name}"? The previous token keeps working for 24h, so live HR ingest won't drop while you update the Pi.`,
    )) return
    setRotatingId(bridge.id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/bridges/${bridge.id}/rotate-token`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to rotate token')
      setReveal({
        token: data.token,
        bridge: data.bridge,
        kind: 'rotated',
        previousExpiresAt: data.previous_token_expires_at,
      })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setRotatingId(null)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <div className="flex items-center gap-2">
        <Radio size={20} className="text-un1t-subtle" />
        <h2 className="text-2xl font-bold">HR Bridges</h2>
      </div>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-un1t-subtle">
        Each studio runs a champ-bridge on a Raspberry Pi that reads
        heart-rate straps over ANT+ and Bluetooth. Register a bridge
        here to get its token, then paste it into the Pi&apos;s config.
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      {reveal && (
        <TokenReveal reveal={reveal} onDone={() => setReveal(null)} />
      )}

      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Registered bridges</h3>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            <Plus size={14} /> Register a bridge
          </button>
        )}
      </div>

      {adding && (
        <RegisterForm
          locations={locations}
          onCancel={() => setAdding(false)}
          onSubmit={handleRegister}
        />
      )}

      {bridges === null && <p className="text-sm text-un1t-subtle">Loading…</p>}

      {bridges && bridges.length === 0 && !adding && (
        <p className="rounded-lg border border-dashed border-un1t-border p-6 text-center text-sm text-un1t-subtle">
          No bridges registered yet. Register one to deploy a studio Pi.
        </p>
      )}

      {bridges && bridges.length > 0 && (
        <ul className="space-y-2">
          {bridges.map((b) => {
            const strapCount = Array.isArray(b.last_seen_straps) ? b.last_seen_straps.length : 0
            return (
              <li
                key={b.id}
                className="rounded-lg border border-un1t-border bg-un1t-surface p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-un1t-text">{b.name}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLES[b.status] || STATUS_STYLES.offline}`}>
                        {b.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-un1t-subtle">
                      {locationName(b.location_id)} · <span className="font-mono">{b.hardware_id}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-un1t-muted">
                      {b.last_seen_at
                        ? `Last seen ${formatSince(b.last_seen_at)}`
                        : 'Never connected'}
                      {b.software_version && ` · v${b.software_version}`}
                      {b.status === 'online' && ` · ${strapCount} strap${strapCount === 1 ? '' : 's'} visible`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRotate(b)}
                    disabled={rotatingId === b.id}
                    className="inline-flex items-center gap-1 rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 text-xs font-medium text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                    title="Issue a new token — invalidates the current one"
                  >
                    <KeyRound size={13} />
                    {rotatingId === b.id ? 'Rotating…' : 'Rotate token'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── token reveal ─────────────────────────────────────────────────

function TokenReveal({ reveal, onDone }) {
  const { token, bridge, kind, previousExpiresAt } = reveal
  // REPSET-P6.S2 — operator snippet points new bridges at the canonical
  // repset CRM host (the legacy host keeps serving existing bridges).
  const envSnippet = `CHAMP_BRIDGE_TOKEN=${token}\nCHAMP_API_URL=https://crm.repset.ie`

  return (
    <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-amber-700" />
        <h3 className="text-sm font-semibold text-amber-900">
          {kind === 'created' ? 'Bridge registered' : 'Token rotated'} — {bridge?.name}
        </h3>
      </div>
      <p className="mt-1 text-xs text-amber-800">
        This token is shown <strong>once</strong>. Copy it now — if you
        lose it you&apos;ll have to rotate again.
      </p>
      {kind === 'rotated' && previousExpiresAt && (
        <p className="mt-1 text-xs text-amber-800">
          The previous token still works until{' '}
          <strong>{formatUntil(previousExpiresAt)}</strong>, so the bridge
          keeps sending HR data while you update the Pi.
        </p>
      )}

      <div className="mt-3">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-amber-800">Token</p>
        <CopyBox value={token} mono />
      </div>

      <div className="mt-3">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-amber-800">
          Paste into the Pi&apos;s <span className="font-mono">.env</span>
        </p>
        <CopyBox value={envSnippet} mono multiline />
      </div>

      <button
        type="button"
        onClick={onDone}
        className="mt-3 rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800"
      >
        Done — I&apos;ve saved the token
      </button>
    </div>
  )
}

function CopyBox({ value, mono, multiline }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex items-stretch gap-2">
      <pre className={`min-w-0 flex-1 overflow-x-auto rounded-md border border-amber-300 bg-white p-2 text-xs text-un1t-text ${mono ? 'font-mono' : ''} ${multiline ? 'whitespace-pre' : 'whitespace-nowrap'}`}>
        {value}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ── register form ────────────────────────────────────────────────

function RegisterForm({ locations, onSubmit, onCancel }) {
  const [name, setName] = useState('')
  const [locationId, setLocationId] = useState(locations[0]?.id || '')
  const [hardwareId, setHardwareId] = useState('')
  const [tailscaleHostname, setTailscaleHostname] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await onSubmit({
        name: name.trim(),
        location_id: locationId,
        hardware_id: hardwareId.trim(),
        tailscale_hostname: tailscaleHostname.trim(),
      })
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 space-y-3 rounded-lg border border-un1t-border bg-un1t-surface p-4"
    >
      <div>
        <label className="block text-xs font-medium text-un1t-subtle">Bridge name</label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Stillorgan studio bridge"
          className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 text-sm"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-un1t-subtle">Location</label>
          <select
            required
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 text-sm"
          >
            <option value="" disabled>Select a studio…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-un1t-subtle">Hardware ID</label>
          <input
            type="text"
            required
            value={hardwareId}
            onChange={(e) => setHardwareId(e.target.value)}
            placeholder="stillorgan-pi-01"
            className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 font-mono text-sm"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-un1t-subtle">
          Tailscale hostname <span className="font-normal text-un1t-muted">(optional)</span>
        </label>
        <input
          type="text"
          value={tailscaleHostname}
          onChange={(e) => setTailscaleHostname(e.target.value)}
          placeholder="stillorgan-bridge"
          className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 font-mono text-sm"
        />
      </div>
      <p className="text-xs text-un1t-muted">
        The hardware ID is a unique label for the physical Pi — anything
        memorable works (e.g. the studio name plus a number). The Tailscale
        hostname is the device name from <span className="font-mono">fleet.yaml</span> in
        un1t-pi, and is what lets fleet alerting tell &ldquo;the Pi is off&rdquo;
        apart from &ldquo;the Pi is on but the bridge is dead&rdquo;. Leave it
        blank if this bridge isn&rsquo;t on the tailnet.
      </p>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim() || !locationId || !hardwareId.trim()}
          className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? 'Registering…' : 'Register bridge'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-un1t-subtle hover:text-un1t-text"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── helpers ──────────────────────────────────────────────────────

function formatSince(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'recently'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function formatUntil(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'in 24h'
  return d.toLocaleString('en-IE', {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  })
}
