'use client'

// AC Devices integration tab — replaces the older SensiboIntegrationTab.
// Unifies Sensibo + LG ThinQ credentials + per-device configuration.
//
// STUDIO-AC-DEVICES.3. Three sections:
//   1. Sensibo credentials (API key only; pod-specific settings are
//      now per-device, not per-location).
//   2. LG ThinQ credentials (PAT + auto-generated client_id, country
//      code).
//   3. Devices — table of ac_devices rows for this location, with
//      Add-device flow (discovery + create) and per-row enable /
//      disable / rename / defaults.
//
// Master + owner can view; master can edit credentials and add /
// remove devices. The dispatcher route enforces master-only at the
// server side too.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import {
  Save, Loader2, Check, AlertCircle, Plus, Power, PowerOff, Edit3, X,
} from 'lucide-react'

// uuid4 generated client-side for ThinQ client_id. crypto.randomUUID
// is available in every browser the CRM supports (set in middleware).
function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // Defensive fallback — unlikely path.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export default function AcDevicesIntegrationTab({ location, canEdit }) {
  const router = useRouter()

  // ---- Sensibo creds ----
  const [sensiboApiKey, setSensiboApiKey] = useState(location.sensibo_api_key || '')

  // ---- ThinQ creds ----
  const [thinqPat, setThinqPat] = useState(location.thinq_pat || '')
  const [thinqClientId, setThinqClientId] = useState(location.thinq_client_id || '')
  const [thinqCountryCode, setThinqCountryCode] = useState(location.thinq_country_code || 'IE')

  // ---- Save state ----
  const [savingCreds, setSavingCreds] = useState(false)
  const [credsError, setCredsError] = useState(null)
  const [credsSavedAt, setCredsSavedAt] = useState(null)

  // ---- Devices ----
  const [devices, setDevices] = useState([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState(null)

  // ---- Add-device flow ----
  const [adding, setAdding] = useState(null)  // 'sensibo' | 'thinq' | null
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const [discoveryError, setDiscoveryError] = useState(null)
  const [discoveryResults, setDiscoveryResults] = useState(null)

  // Hydrate the devices table after creds are saved or on mount.
  useEffect(() => { loadDevices() }, [])

  async function loadDevices() {
    setDevicesLoading(true); setDevicesError(null)
    try {
      const r = await fetch('/api/studio-management/ac/devices', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Failed (${r.status})`)
      setDevices(j.data || [])
    } catch (e) {
      setDevicesError(e.message || 'Failed to load devices')
    } finally {
      setDevicesLoading(false)
    }
  }

  async function saveCreds() {
    setSavingCreds(true); setCredsError(null); setCredsSavedAt(null)
    // If the operator typed a PAT but client_id is still empty,
    // generate one now so the next /lg-devices call has something to
    // present. The dispatcher requires a non-empty client_id.
    let clientId = thinqClientId
    if (thinqPat.trim() && !clientId.trim()) {
      clientId = newClientId()
      setThinqClientId(clientId)
    }
    const db = createBrowserClient()
    const { error: upErr } = await db
      .from('locations')
      .update({
        sensibo_api_key: sensiboApiKey.trim() || null,
        thinq_pat: thinqPat.trim() || null,
        thinq_client_id: clientId.trim() || null,
        thinq_country_code: thinqCountryCode.trim() || 'IE',
        updated_at: new Date().toISOString(),
      })
      .eq('id', location.id)
    setSavingCreds(false)
    if (upErr) { setCredsError(upErr.message); return }
    setCredsSavedAt(new Date())
    router.refresh()
  }

  async function startDiscovery(provider) {
    setAdding(provider)
    setDiscoveryResults(null)
    setDiscoveryError(null)
    setDiscoveryLoading(true)
    try {
      const path = provider === 'sensibo'
        ? `/api/studio-management/ac/pods${sensiboApiKey ? `?api_key=${encodeURIComponent(sensiboApiKey.trim())}` : ''}`
        : `/api/studio-management/ac/lg-devices` // server falls back to saved location values
      const r = await fetch(path, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Discovery failed (${r.status})`)
      setDiscoveryResults(j.data || [])
    } catch (e) {
      setDiscoveryError(e.message || 'Discovery failed')
    } finally {
      setDiscoveryLoading(false)
    }
  }

  async function addDevice(provider, providerDeviceId, label) {
    try {
      const r = await fetch('/api/studio-management/ac/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, provider_device_id: providerDeviceId, label }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        alert(j.error || `Add failed (${r.status})`)
        return
      }
      setAdding(null)
      setDiscoveryResults(null)
      await loadDevices()
    } catch (e) {
      alert(e.message || 'Add failed')
    }
  }

  async function disableDevice(deviceId, label) {
    if (!confirm(`Disable "${label}"? Staff will lose access. You can re-enable from this same screen.`)) return
    try {
      const r = await fetch(`/api/studio-management/ac/devices/${deviceId}`, {
        method: 'DELETE',
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        alert(j.error || `Disable failed (${r.status})`)
        return
      }
      await loadDevices()
    } catch (e) {
      alert(e.message || 'Disable failed')
    }
  }

  async function patchDevice(deviceId, patch) {
    try {
      const r = await fetch(`/api/studio-management/ac/devices/${deviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        alert(j.error || `Save failed (${r.status})`)
        return
      }
      await loadDevices()
    } catch (e) {
      alert(e.message || 'Save failed')
    }
  }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-light">
        Only owners + masters can edit AC settings.
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-un1t-light">
        AC devices at this location. Sensibo and LG ThinQ are supported.
        Credentials are per-account-per-vendor (one Sensibo API key
        controls all pods on that account; one ThinQ PAT controls all
        LG devices on that account); the device list below is per
        physical unit and gets a per-staff allowlist on the staff edit
        screen.
      </p>

      {/* ============================================================
          1. Sensibo credentials
      ============================================================ */}
      <section className="space-y-3">
        <h4 className="text-xs font-bold text-un1t-white uppercase tracking-wider">Sensibo credentials</h4>
        <Field label="API key" hint="From Sensibo Web → Profile → API Keys.">
          <input
            type="text"
            value={sensiboApiKey}
            onChange={(e) => setSensiboApiKey(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white"
            placeholder="paste Sensibo API key"
          />
        </Field>
      </section>

      {/* ============================================================
          2. LG ThinQ credentials
      ============================================================ */}
      <section className="space-y-3">
        <h4 className="text-xs font-bold text-un1t-white uppercase tracking-wider">LG ThinQ credentials</h4>
        <p className="text-[11px] text-un1t-mid">
          Generate a PAT at <a href="https://connect-pat.lgthinq.com/" target="_blank" rel="noopener noreferrer" className="text-un1t-white underline">connect-pat.lgthinq.com</a> scoped to Air Conditioner status + control. Client id is auto-generated when you first save a PAT.
        </p>
        <Field label="Personal Access Token (PAT)">
          <input
            type="text"
            value={thinqPat}
            onChange={(e) => setThinqPat(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white"
            placeholder="paste LG ThinQ PAT"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client ID" hint="uuid4 — auto-generated on first save.">
            <input
              type="text"
              value={thinqClientId}
              onChange={(e) => setThinqClientId(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white"
              placeholder="auto-generated on save"
            />
          </Field>
          <Field label="Country code" hint="Two-letter ISO. Defaults to IE.">
            <input
              type="text"
              value={thinqCountryCode}
              onChange={(e) => setThinqCountryCode(e.target.value.toUpperCase())}
              maxLength={2}
              className="w-24 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono uppercase text-un1t-white"
            />
          </Field>
        </div>
      </section>

      {/* ============================================================
          Save credentials
      ============================================================ */}
      {credsError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {credsError}
        </div>
      )}
      {credsSavedAt && !credsError && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-xs rounded-md p-2 inline-flex items-center gap-2">
          <Check size={12} /> Credentials saved at {credsSavedAt.toLocaleTimeString()}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={saveCreds}
          disabled={savingCreds}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {savingCreds
            ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
            : <><Save size={12} /> Save credentials</>
          }
        </button>
      </div>

      {/* ============================================================
          3. Devices table
      ============================================================ */}
      <section className="space-y-3 pt-4 border-t border-un1t-gray/40">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold text-un1t-white uppercase tracking-wider">Devices</h4>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => startDiscovery('sensibo')}
              disabled={!sensiboApiKey.trim() || discoveryLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-un1t-gray text-xs text-un1t-light hover:text-un1t-white disabled:opacity-50"
              title={!sensiboApiKey.trim() ? 'Save a Sensibo API key first' : ''}
            >
              <Plus size={11} /> Add Sensibo
            </button>
            <button
              type="button"
              onClick={() => startDiscovery('thinq')}
              disabled={!thinqPat.trim() || !thinqClientId.trim() || discoveryLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-un1t-gray text-xs text-un1t-light hover:text-un1t-white disabled:opacity-50"
              title={!thinqPat.trim() ? 'Save a ThinQ PAT first' : ''}
            >
              <Plus size={11} /> Add LG ThinQ
            </button>
          </div>
        </div>

        {/* Add-device discovery panel */}
        {adding && (
          <div className="bg-un1t-black/60 border border-un1t-gray rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-un1t-white">
                Discover {adding === 'sensibo' ? 'Sensibo pods' : 'LG ThinQ devices'}
              </span>
              <button
                type="button"
                onClick={() => { setAdding(null); setDiscoveryResults(null); setDiscoveryError(null) }}
                className="text-un1t-light hover:text-un1t-white"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            {discoveryLoading && (
              <div className="text-xs text-un1t-light inline-flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" /> Asking the vendor…
              </div>
            )}
            {discoveryError && (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
                <AlertCircle size={11} className="mt-0.5" /> {discoveryError}
              </div>
            )}
            {discoveryResults && discoveryResults.length === 0 && (
              <div className="text-xs text-un1t-light">No devices returned by the vendor.</div>
            )}
            {discoveryResults && discoveryResults.length > 0 && (
              <div className="space-y-1">
                {discoveryResults.map((r) => {
                  const pdid = adding === 'sensibo' ? r.id : r.device_id
                  const defaultLabel = adding === 'sensibo'
                    ? (r.room_name || r.product_model || pdid)
                    : (r.alias || r.model || pdid)
                  return (
                    <button
                      key={pdid}
                      type="button"
                      onClick={() => {
                        const name = prompt(`CRM label for this device?`, defaultLabel)
                        if (name && name.trim()) addDevice(adding, pdid, name.trim())
                      }}
                      className="w-full text-left bg-un1t-black border border-un1t-gray rounded p-2 hover:border-un1t-mid"
                    >
                      <div className="text-sm text-un1t-white">{defaultLabel}</div>
                      <div className="text-[11px] text-un1t-mid font-mono">{pdid}</div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Devices list */}
        {devicesLoading && devices.length === 0 && (
          <div className="text-xs text-un1t-light inline-flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        )}
        {devicesError && (
          <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
            <AlertCircle size={11} className="mt-0.5" /> {devicesError}
          </div>
        )}
        {!devicesLoading && devices.length === 0 && (
          <div className="text-xs text-un1t-light">
            No devices configured. Add one above after saving credentials.
          </div>
        )}
        {devices.length > 0 && (
          <div className="space-y-2">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                onPatch={(patch) => patchDevice(d.id, patch)}
                onDisable={() => disableDevice(d.id, d.label)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ============================================================
// DeviceRow — inline-editable per-device card
// ============================================================

function DeviceRow({ device, onPatch, onDisable }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(device.label)
  const [mode, setMode] = useState(device.default_mode || 'cool')
  const [tempC, setTempC] = useState(device.default_temp_c ?? 22)
  const [fan, setFan] = useState(device.default_fan || 'auto')
  const [sessionMinutes, setSessionMinutes] = useState(device.session_minutes ?? 30)

  function reset() {
    setLabel(device.label)
    setMode(device.default_mode || 'cool')
    setTempC(device.default_temp_c ?? 22)
    setFan(device.default_fan || 'auto')
    setSessionMinutes(device.session_minutes ?? 30)
  }

  async function save() {
    await onPatch({
      label: label.trim() || device.label,
      default_mode: mode,
      default_temp_c: Number(tempC),
      default_fan: fan,
      session_minutes: Number(sessionMinutes),
    })
    setEditing(false)
  }

  return (
    <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-un1t-white truncate">{device.label}</span>
            <span className="text-[10px] uppercase tracking-wider text-un1t-mid font-mono">
              {device.provider === 'thinq' ? 'LG ThinQ' : 'Sensibo'}
            </span>
            {!device.enabled && (
              <span className="text-[10px] uppercase tracking-wider text-red-400">disabled</span>
            )}
          </div>
          <div className="text-[11px] text-un1t-light mt-0.5">
            Default: {device.default_mode} · {device.default_temp_c}°C · fan {device.default_fan} · {device.session_minutes} min
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => { reset(); setEditing(!editing) }}
            className="text-un1t-light hover:text-un1t-white"
            aria-label={editing ? 'Cancel edit' : 'Edit device'}
          >
            {editing ? <X size={14} /> : <Edit3 size={14} />}
          </button>
          {device.enabled ? (
            <button
              type="button"
              onClick={onDisable}
              className="text-red-300 hover:text-red-200"
              aria-label="Disable device"
              title="Disable"
            >
              <PowerOff size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onPatch({ enabled: true })}
              className="text-green-300 hover:text-green-200"
              aria-label="Re-enable device"
              title="Re-enable"
            >
              <Power size={14} />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 pt-3 border-t border-un1t-gray/40 space-y-2">
          <Field label="Label">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </Field>
          <div className="grid grid-cols-4 gap-2">
            <Field label="Mode">
              <select value={mode} onChange={(e) => setMode(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-2 py-2 text-sm text-un1t-white">
                <option value="cool">Cool</option>
                <option value="heat">Heat</option>
                <option value="auto">Auto</option>
                <option value="fan">Fan</option>
                <option value="dry">Dry</option>
              </select>
            </Field>
            <Field label="Temp °C">
              <input type="number" min={16} max={30} value={tempC}
                onChange={(e) => setTempC(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-2 py-2 text-sm text-un1t-white" />
            </Field>
            <Field label="Fan">
              <select value={fan} onChange={(e) => setFan(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-2 py-2 text-sm text-un1t-white">
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
            <Field label="Session (min)">
              <input type="number" min={5} max={720} value={sessionMinutes}
                onChange={(e) => setSessionMinutes(e.target.value)}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-2 py-2 text-sm text-un1t-white" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { reset(); setEditing(false) }}
              className="text-xs text-un1t-light hover:text-un1t-white px-3 py-1.5">
              Cancel
            </button>
            <button type="button" onClick={save}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-un1t-white text-un1t-black text-xs font-semibold hover:bg-un1t-accent">
              <Save size={11} /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className="flex-1">
      <label className="block text-xs text-un1t-light mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-mid mt-1">{hint}</p>}
    </div>
  )
}

