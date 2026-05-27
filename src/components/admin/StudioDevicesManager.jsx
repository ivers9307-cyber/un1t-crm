'use client'

// STUDIO-PIN.2 — admin UI for paired devices + trusted IPs.
//
// Two panels:
//   - Trusted IPs (per location) — list + add + remove. The IP gate
//     for PIN-login is checked against these CIDRs.
//   - Paired devices — list across all locations + pair new + revoke.
//     On pair, the cleartext token is shown ONCE in a banner.
//
// Both panels are master-only — the server-side routes enforce that;
// this page is also redirect-gated in the parent server component.
//
// Mutations go through fetch(); on success we re-fetch the relevant
// list to refresh the table. No optimistic state — the round-trip is
// fast enough that the simpler shape is worth the half-second.

import { useEffect, useState } from 'react'
import {
  Wifi, WifiOff, Smartphone, Monitor, Plus, Trash2,
  Copy, Check, AlertTriangle,
} from 'lucide-react'

export default function StudioDevicesManager({ locations }) {
  const [trustedIps, setTrustedIps] = useState([])
  const [devices, setDevices] = useState([])
  const [loadingIps, setLoadingIps] = useState(true)
  const [loadingDevices, setLoadingDevices] = useState(true)
  const [error, setError] = useState(null)
  const [pairingToken, setPairingToken] = useState(null) // shown once
  const [tokenCopied, setTokenCopied] = useState(false)

  // --------- fetchers ---------
  const refreshIps = async () => {
    setLoadingIps(true)
    try {
      const res = await fetch('/api/admin/location-trusted-ips')
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Failed to load')
      setTrustedIps(json.ips || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingIps(false)
    }
  }

  const refreshDevices = async () => {
    setLoadingDevices(true)
    try {
      const res = await fetch('/api/admin/studio-devices')
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Failed to load')
      setDevices(json.devices || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingDevices(false)
    }
  }

  useEffect(() => {
    refreshIps()
    refreshDevices()
  }, [])

  // --------- mutations ---------
  const addIp = async (form) => {
    setError(null)
    const res = await fetch('/api/admin/location-trusted-ips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    })
    const json = await res.json()
    if (!res.ok || !json.success) {
      setError(json.error || 'Failed to add trusted IP')
      return false
    }
    await refreshIps()
    return true
  }

  const removeIp = async (id) => {
    if (!confirm('Remove this trusted IP? Devices on this network will no longer be able to PIN-login.')) return
    setError(null)
    const res = await fetch(`/api/admin/location-trusted-ips/${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok || !json.success) {
      setError(json.error || 'Failed to remove')
      return
    }
    await refreshIps()
  }

  const pairDevice = async (form) => {
    setError(null)
    setPairingToken(null)
    setTokenCopied(false)
    const res = await fetch('/api/admin/studio-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    })
    const json = await res.json()
    if (!res.ok || !json.success) {
      setError(json.error || 'Failed to pair device')
      return false
    }
    setPairingToken({ token: json.pairing_token, device: json.device })
    await refreshDevices()
    return true
  }

  const revokeDevice = async (id, label) => {
    if (!confirm(`Revoke "${label || 'this device'}"? Its pairing token will stop working immediately.`)) return
    setError(null)
    const res = await fetch(`/api/admin/studio-devices/${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok || !json.success) {
      setError(json.error || 'Failed to revoke')
      return
    }
    await refreshDevices()
  }

  const copyToken = async () => {
    if (!pairingToken?.token) return
    try {
      await navigator.clipboard.writeText(pairingToken.token)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    } catch {
      // ignore; user can select + copy manually
    }
  }

  // --------- render ---------
  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 p-3 text-sm flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {pairingToken && (
        <PairingTokenBanner
          token={pairingToken.token}
          device={pairingToken.device}
          locations={locations}
          copied={tokenCopied}
          onCopy={copyToken}
          onDismiss={() => setPairingToken(null)}
        />
      )}

      <TrustedIpsPanel
        ips={trustedIps}
        locations={locations}
        loading={loadingIps}
        onAdd={addIp}
        onRemove={removeIp}
      />

      <DevicesPanel
        devices={devices}
        locations={locations}
        loading={loadingDevices}
        onPair={pairDevice}
        onRevoke={revokeDevice}
      />
    </div>
  )
}

// ============================================================
// Trusted IPs panel
// ============================================================

function TrustedIpsPanel({ ips, locations, loading, onAdd, onRemove }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ location_id: '', ip_cidr: '', label: '' })
  const [submitting, setSubmitting] = useState(false)

  const locName = (id) => locations.find((l) => l.id === id)?.name || id

  const submit = async (e) => {
    e.preventDefault()
    if (!form.location_id || !form.ip_cidr) return
    setSubmitting(true)
    const ok = await onAdd({
      location_id: form.location_id,
      ip_cidr: form.ip_cidr.trim(),
      label: form.label.trim() || undefined,
    })
    setSubmitting(false)
    if (ok) {
      setForm({ location_id: '', ip_cidr: '', label: '' })
      setShowForm(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Wifi size={16} className="text-blue-400" /> Trusted IPs
          </h3>
          <p className="text-xs text-un1t-light mt-0.5">
            CIDRs that PIN-login accepts as &quot;on studio wifi.&quot; Get the studio&apos;s public IP from <a className="underline" href="https://www.whatismyip.com/" target="_blank" rel="noreferrer">whatismyip.com</a> when standing on the studio network.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-un1t-white text-un1t-black hover:bg-un1t-light/90 transition-colors"
        >
          <Plus size={14} /> Add IP
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="rounded-lg border border-un1t-gray bg-un1t-dark p-4 mb-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-un1t-light">Location</span>
            <select
              required
              value={form.location_id}
              onChange={(e) => setForm({ ...form, location_id: e.target.value })}
              className="bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
            >
              <option value="">— pick a location —</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-un1t-light">CIDR</span>
            <input
              required
              type="text"
              placeholder="203.0.113.0/24 or 192.168.1.10"
              value={form.ip_cidr}
              onChange={(e) => setForm({ ...form, ip_cidr: e.target.value })}
              className="bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-un1t-light">Label (optional)</span>
            <input
              type="text"
              placeholder="Main wifi"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              className="bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs px-3 py-2 rounded-lg border border-un1t-gray text-un1t-light hover:text-un1t-white"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="rounded-lg border border-un1t-gray overflow-hidden">
        {loading ? (
          <div className="p-4 text-xs text-un1t-light">Loading...</div>
        ) : ips.length === 0 ? (
          <div className="p-4 text-xs text-un1t-light flex items-center gap-2">
            <WifiOff size={14} /> No trusted IPs configured yet. Add the studio&apos;s public IP before pairing any devices.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-un1t-light bg-un1t-gray/30">
              <tr>
                <th className="text-left px-3 py-2">Location</th>
                <th className="text-left px-3 py-2">CIDR</th>
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2">Added</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-un1t-gray">
              {ips.map((ip) => (
                <tr key={ip.id} className="hover:bg-un1t-gray/20">
                  <td className="px-3 py-2 text-un1t-white">{locName(ip.location_id)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{ip.ip_cidr}</td>
                  <td className="px-3 py-2 text-un1t-light">{ip.label || <span className="text-un1t-mid italic">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-un1t-light">
                    {new Date(ip.created_at).toLocaleDateString('en-IE')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => onRemove(ip.id)}
                      className="text-xs text-red-400 hover:text-red-300 inline-flex items-center gap-1"
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

// ============================================================
// Devices panel
// ============================================================

function DevicesPanel({ devices, locations, loading, onPair, onRevoke }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ location_id: '', device_kind: 'mac', label: '' })
  const [submitting, setSubmitting] = useState(false)

  const locName = (id) => locations.find((l) => l.id === id)?.name || id

  const submit = async (e) => {
    e.preventDefault()
    if (!form.location_id || !form.label) return
    setSubmitting(true)
    const ok = await onPair(form)
    setSubmitting(false)
    if (ok) {
      setForm({ location_id: '', device_kind: 'mac', label: '' })
      setShowForm(false)
    }
  }

  const active = devices.filter((d) => !d.revoked_at)
  const revoked = devices.filter((d) => d.revoked_at)

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Monitor size={16} className="text-purple-400" /> Paired devices
          </h3>
          <p className="text-xs text-un1t-light mt-0.5">
            Each Mac shell or iPad in the studio needs to be paired before staff can PIN-login on it.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-un1t-white text-un1t-black hover:bg-un1t-light/90 transition-colors"
        >
          <Plus size={14} /> Pair new device
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="rounded-lg border border-un1t-gray bg-un1t-dark p-4 mb-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-un1t-light">Location</span>
            <select
              required
              value={form.location_id}
              onChange={(e) => setForm({ ...form, location_id: e.target.value })}
              className="bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
            >
              <option value="">— pick a location —</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-un1t-light">Kind</span>
            <select
              value={form.device_kind}
              onChange={(e) => setForm({ ...form, device_kind: e.target.value })}
              className="bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
            >
              <option value="mac">Mac</option>
              <option value="ipad">iPad</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-un1t-light">Label</span>
            <input
              required
              type="text"
              placeholder="Reception Mac"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              className="bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-un1t-white"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            >
              {submitting ? 'Pairing...' : 'Pair device'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs px-3 py-2 rounded-lg border border-un1t-gray text-un1t-light hover:text-un1t-white"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <DevicesTable
        title="Active"
        rows={active}
        locName={locName}
        loading={loading}
        onRevoke={onRevoke}
      />

      {revoked.length > 0 && (
        <div className="mt-6 opacity-60">
          <DevicesTable
            title="Revoked"
            rows={revoked}
            locName={locName}
            loading={false}
            onRevoke={null}
          />
        </div>
      )}
    </section>
  )
}

function DevicesTable({ title, rows, locName, loading, onRevoke }) {
  return (
    <div className="rounded-lg border border-un1t-gray overflow-hidden">
      <div className="text-xs uppercase tracking-wider text-un1t-light px-3 py-2 bg-un1t-gray/30">
        {title} ({rows.length})
      </div>
      {loading ? (
        <div className="p-4 text-xs text-un1t-light">Loading...</div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-xs text-un1t-light">None.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-un1t-light bg-un1t-gray/20">
            <tr>
              <th className="text-left px-3 py-2">Label</th>
              <th className="text-left px-3 py-2">Kind</th>
              <th className="text-left px-3 py-2">Location</th>
              <th className="text-left px-3 py-2">Paired</th>
              <th className="text-left px-3 py-2">Last seen</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-gray">
            {rows.map((d) => (
              <tr key={d.id} className="hover:bg-un1t-gray/20">
                <td className="px-3 py-2 text-un1t-white">{d.label || <span className="text-un1t-mid italic">—</span>}</td>
                <td className="px-3 py-2 text-un1t-light inline-flex items-center gap-1.5">
                  {d.device_kind === 'ipad' ? <Smartphone size={12} /> : <Monitor size={12} />}
                  {d.device_kind}
                </td>
                <td className="px-3 py-2 text-un1t-light">{locName(d.location_id)}</td>
                <td className="px-3 py-2 text-xs text-un1t-light">
                  {new Date(d.paired_at).toLocaleDateString('en-IE')}
                </td>
                <td className="px-3 py-2 text-xs text-un1t-light">
                  {d.last_seen_at
                    ? new Date(d.last_seen_at).toLocaleString('en-IE', { dateStyle: 'short', timeStyle: 'short' })
                    : <span className="text-un1t-mid italic">never</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {onRevoke && (
                    <button
                      onClick={() => onRevoke(d.id, d.label)}
                      className="text-xs text-red-400 hover:text-red-300 inline-flex items-center gap-1"
                    >
                      <Trash2 size={12} /> Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ============================================================
// Pairing-token banner (shown once after a successful pair)
// ============================================================

function PairingTokenBanner({ token, device, locations, copied, onCopy, onDismiss }) {
  const locName = locations.find((l) => l.id === device.location_id)?.name || device.location_id
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="text-amber-300 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-amber-100">
            Pairing token for &quot;{device.label}&quot; ({device.device_kind} · {locName})
          </div>
          <div className="text-xs text-amber-100/80 mt-1">
            Copy this now — it&apos;s shown only once. Paste it into the device&apos;s pairing screen.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-un1t-black/40 border border-amber-500/30 rounded px-3 py-2 text-amber-100 break-all">
              {token}
            </code>
            <button
              onClick={onCopy}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950"
            >
              {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
            </button>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="text-xs text-amber-100/70 hover:text-amber-100 underline shrink-0"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
