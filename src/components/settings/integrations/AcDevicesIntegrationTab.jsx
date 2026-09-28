'use client'

// AC Devices integration tab — Sensibo + LG ThinQ credentials and the AC
// units of THIS location (the one in the URL, `location.id`).
//
// STUDIO-AC-DEVICES.3. Three sections:
//   1. Sensibo credentials (API key only).
//   2. LG ThinQ credentials (PAT + client id, country code).
//   3. The units at this location: discovery + add, and per-row
//      enable / disable / rename / defaults.
//
// ACDEVLOC.1 — everything here acts on `location.id`, never the caller's
// active studio: list, discovery, add and edits go through
// /api/locations/[id]/ac-devices…, credentials through
// PUT /api/locations/[id]/integrations/ac (write-only secrets, masked echo,
// registry re-sync in the handler). The stored key and PAT never reach the
// browser: the page sends has_sensibo_key / has_thinq_pat, a typed secret
// travels once in a request BODY, and a URL never carries one.
//
// Master + owner can view (`canEdit`); only a master manages (`canManage`),
// the same rule every route behind this tab enforces.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Save, Loader2, Check, AlertCircle, Plus, Power, PowerOff, Edit3, X,
} from 'lucide-react'
import ReadFailedNote from '@/components/settings/ReadFailedNote'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export default function AcDevicesIntegrationTab({ location, canEdit, canManage = false }) {
  const router = useRouter()

  // ---- Credentials: write-only. Stored values never reach the browser. ----
  const [hasSensiboKey, setHasSensiboKey] = useState(!!location.has_sensibo_key)
  const [hasThinqPat, setHasThinqPat] = useState(!!location.has_thinq_pat)
  const [sensiboApiKey, setSensiboApiKey] = useState('')
  const [thinqPat, setThinqPat] = useState('')
  const [thinqClientId, setThinqClientId] = useState(location.thinq_client_id || '')
  const [thinqCountryCode, setThinqCountryCode] = useState(location.thinq_country_code || 'IE')

  // ---- Save state ----
  const [savingCreds, setSavingCreds] = useState(false)
  const [credsError, setCredsError] = useState(null)
  const [credsSavedAt, setCredsSavedAt] = useState(null)

  // ---- Devices ----
  // CHANNELREAD.1 — `devices` is null until a read SUCCEEDS, and a failed
  // read puts it back to null: no "No devices configured", no Add buttons
  // over a list we could not read.
  const [devices, setDevices] = useState(null)
  // true from the first render: with `devices` null and loading false, the
  // "could not load" note would flash before the mount effect starts the read.
  const [devicesLoading, setDevicesLoading] = useState(true)

  // ---- Add-device flow ----
  const [adding, setAdding] = useState(null)  // 'sensibo' | 'thinq' | null
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const [discoveryError, setDiscoveryError] = useState(null)
  const [discoveryResults, setDiscoveryResults] = useState(null)

  useEffect(() => { loadDevices() }, [])

  // silent: the Try again re-read keeps ReadFailedNote mounted, so a retry
  // that fails again can say so ("Still could not load").
  async function loadDevices({ silent = false } = {}) {
    if (!silent) setDevicesLoading(true)
    try {
      // include_disabled: a disabled unit must stay listed so it can be re-enabled.
      const r = await fetch(`/api/locations/${location.id}/ac-devices?include_disabled=1`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success !== true || !Array.isArray(j.devices)) throw new Error(j.error || `Failed (${r.status})`)
      setDevices(j.devices)
    } catch {
      setDevices(null)
    } finally {
      setDevicesLoading(false)
    }
  }

  async function saveCreds() {
    setSavingCreds(true); setCredsError(null); setCredsSavedAt(null)
    // Only what was typed is sent. A secret left blank keeps the stored one
    // (the route's write-only merge); a blank client id is left out too, so
    // the stored one is kept (the route generates one when a PAT first
    // arrives without it).
    const body = {}
    if (sensiboApiKey.trim()) body.sensibo_api_key = sensiboApiKey.trim()
    if (thinqPat.trim()) body.thinq_pat = thinqPat.trim()
    if (thinqClientId.trim()) body.thinq_client_id = thinqClientId.trim()
    if (thinqCountryCode.trim()) body.thinq_country_code = thinqCountryCode.trim()
    try {
      const r = await fetch(`/api/locations/${location.id}/integrations/ac`, {
        method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success !== true) throw new Error(j.error || `Save failed (${r.status})`)
      setHasSensiboKey(!!j.data?.has_sensibo_key)
      setHasThinqPat(!!j.data?.has_thinq_pat)
      setThinqClientId(j.data?.thinq_client_id || '')
      setThinqCountryCode(j.data?.thinq_country_code || 'IE')
      setSensiboApiKey('')
      setThinqPat('')
      setCredsSavedAt(new Date())
      router.refresh()
    } catch (e) {
      setCredsError(e.message || 'Save failed')
    } finally {
      setSavingCreds(false)
    }
  }

  async function startDiscovery(provider) {
    setAdding(provider)
    setDiscoveryResults(null)
    setDiscoveryError(null)
    setDiscoveryLoading(true)
    // POST, credential in the BODY and only when just typed; otherwise the
    // server uses what is stored on this location.
    const body = { provider }
    if (provider === 'sensibo' && sensiboApiKey.trim()) body.api_key = sensiboApiKey.trim()
    if (provider === 'thinq') {
      if (thinqPat.trim()) body.pat = thinqPat.trim()
      if (thinqClientId.trim()) body.client_id = thinqClientId.trim()
      if (thinqCountryCode.trim()) body.country_code = thinqCountryCode.trim()
    }
    try {
      const r = await fetch(`/api/locations/${location.id}/ac-devices/discover`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success !== true || !Array.isArray(j.data)) throw new Error(j.error || `Discovery failed (${r.status})`)
      setDiscoveryResults(j.data)
    } catch (e) {
      setDiscoveryError(e.message || 'Discovery failed')
    } finally {
      setDiscoveryLoading(false)
    }
  }

  async function addDevice(provider, providerDeviceId, label) {
    try {
      const r = await fetch(`/api/locations/${location.id}/ac-devices`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ provider, provider_device_id: providerDeviceId, label }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success !== true) {
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

  async function patchDevice(deviceId, patch, verb = 'Save') {
    try {
      const r = await fetch(`/api/locations/${location.id}/ac-devices/${deviceId}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success !== true) {
        alert(j.error || `${verb} failed (${r.status})`)
        return
      }
      await loadDevices()
    } catch (e) {
      alert(e.message || `${verb} failed`)
    }
  }

  function disableDevice(deviceId, label) {
    if (!confirm(`Disable "${label}"? Staff will lose access. You can re-enable it from this same screen.`)) return
    return patchDevice(deviceId, { enabled: false }, 'Disable')
  }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-subtle">
        Only owners + masters can edit AC settings.
      </div>
    )
  }

  const sensiboReady = hasSensiboKey || !!sensiboApiKey.trim()
  const thinqReady = (hasThinqPat || !!thinqPat.trim()) && !!thinqClientId.trim()
  const inputClass = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text'

  return (
    <div className="space-y-8">
      <p className="text-xs text-un1t-subtle">
        AC devices at this location. Sensibo and LG ThinQ are supported.
        Credentials are per-account-per-vendor (one Sensibo API key
        controls all pods on that account; one ThinQ PAT controls all
        LG devices on that account); the device list below is per
        physical unit and gets a per-staff allowlist on the staff edit
        screen. Saved keys are never shown here.
      </p>

      {/* ============================================================
          1. Sensibo credentials
      ============================================================ */}
      <section className="space-y-3">
        <h4 className="text-xs font-bold text-un1t-text uppercase tracking-wider">Sensibo credentials</h4>
        <Field
          label="API key"
          hint={hasSensiboKey
            ? 'Saved. It is never shown here; paste a new key to replace it.'
            : 'From Sensibo Web → Profile → API Keys.'}
        >
          {canManage ? (
            <input
              type="password"
              autoComplete="new-password"
              aria-label="Sensibo API key"
              value={sensiboApiKey}
              onChange={(e) => setSensiboApiKey(e.target.value)}
              className={inputClass}
              placeholder={hasSensiboKey ? 'Saved (hidden)' : 'paste Sensibo API key'}
            />
          ) : (
            <div className="text-sm text-un1t-text">{hasSensiboKey ? 'Saved' : 'Not set'}</div>
          )}
        </Field>
      </section>

      {/* ============================================================
          2. LG ThinQ credentials
      ============================================================ */}
      <section className="space-y-3">
        <h4 className="text-xs font-bold text-un1t-text uppercase tracking-wider">LG ThinQ credentials</h4>
        <p className="text-[11px] text-un1t-muted">
          Generate a PAT at <a href="https://connect-pat.lgthinq.com/" target="_blank" rel="noopener noreferrer" className="text-un1t-text underline">connect-pat.lgthinq.com</a> scoped to Air Conditioner status + control. The client id is generated when you first save a PAT.
        </p>
        <Field label="Personal Access Token (PAT)" hint={hasThinqPat ? 'Saved. It is never shown here; paste a new PAT to replace it.' : undefined}>
          {canManage ? (
            <input
              type="password"
              autoComplete="new-password"
              aria-label="LG ThinQ PAT"
              value={thinqPat}
              onChange={(e) => setThinqPat(e.target.value)}
              className={inputClass}
              placeholder={hasThinqPat ? 'Saved (hidden)' : 'paste LG ThinQ PAT'}
            />
          ) : (
            <div className="text-sm text-un1t-text">{hasThinqPat ? 'Saved' : 'Not set'}</div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client ID" hint="uuid4, generated on the first PAT save.">
            {canManage ? (
              <input
                type="text"
                aria-label="ThinQ client ID"
                value={thinqClientId}
                onChange={(e) => setThinqClientId(e.target.value)}
                className={inputClass}
                placeholder="generated on save"
              />
            ) : (
              <div className="text-sm font-mono text-un1t-text">{thinqClientId || 'Not set'}</div>
            )}
          </Field>
          <Field label="Country code" hint="Two-letter ISO. Defaults to IE.">
            {canManage ? (
              <input
                type="text"
                aria-label="ThinQ country code"
                value={thinqCountryCode}
                onChange={(e) => setThinqCountryCode(e.target.value.toUpperCase())}
                maxLength={2}
                className="w-24 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono uppercase text-un1t-text"
              />
            ) : (
              <div className="text-sm font-mono text-un1t-text">{thinqCountryCode}</div>
            )}
          </Field>
        </div>
      </section>

      {/* ============================================================
          Save credentials (master only)
      ============================================================ */}
      {credsError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {credsError}
        </div>
      )}
      {credsSavedAt && !credsError && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-xs rounded-md p-2 inline-flex items-center gap-2">
          <Check size={12} /> Credentials saved at {credsSavedAt.toLocaleTimeString()}
        </div>
      )}
      {canManage && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={saveCreds}
            disabled={savingCreds}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {savingCreds
              ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
              : <><Save size={12} /> Save credentials</>
            }
          </button>
        </div>
      )}

      {/* ============================================================
          3. Devices table
      ============================================================ */}
      <section className="space-y-3 pt-4 border-t border-un1t-border/40">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold text-un1t-text uppercase tracking-wider">Devices</h4>
          {canManage && devices !== null && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => startDiscovery('sensibo')}
                disabled={!sensiboReady || discoveryLoading}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-un1t-border text-xs text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                title={!sensiboReady ? 'Save or paste a Sensibo API key first' : ''}
              >
                <Plus size={11} /> Add Sensibo
              </button>
              <button
                type="button"
                onClick={() => startDiscovery('thinq')}
                disabled={!thinqReady || discoveryLoading}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-un1t-border text-xs text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                title={!thinqReady ? 'Save a ThinQ PAT first (a client id is generated then)' : ''}
              >
                <Plus size={11} /> Add LG ThinQ
              </button>
            </div>
          )}
        </div>

        {/* Add-device discovery panel (never over an unread device list) */}
        {adding && devices !== null && (
          <div className="bg-un1t-bg/60 border border-un1t-border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-un1t-text">
                Discover {adding === 'sensibo' ? 'Sensibo pods' : 'LG ThinQ devices'}
              </span>
              <button
                type="button"
                onClick={() => { setAdding(null); setDiscoveryResults(null); setDiscoveryError(null) }}
                className="text-un1t-subtle hover:text-un1t-text"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            {discoveryLoading && (
              <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" /> Asking the vendor…
              </div>
            )}
            {discoveryError && (
              <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
                <AlertCircle size={11} className="mt-0.5" /> {discoveryError}
              </div>
            )}
            {discoveryResults && discoveryResults.length === 0 && (
              <div className="text-xs text-un1t-subtle">No devices returned by the vendor.</div>
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
                      className="w-full text-left bg-un1t-bg border border-un1t-border rounded p-2 hover:border-un1t-muted"
                    >
                      <div className="text-sm text-un1t-text">{defaultLabel}</div>
                      <div className="text-[11px] text-un1t-muted font-mono">{pdid}</div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Devices list */}
        {devicesLoading && devices === null && (
          <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        )}
        {!devicesLoading && devices === null && (
          <ReadFailedNote what="this studio's AC devices" onRetry={() => loadDevices({ silent: true })} />
        )}
        {devices !== null && devices.length === 0 && (
          <div className="text-xs text-un1t-subtle">
            No devices configured.{canManage ? ' Add one above after saving credentials.' : ''}
          </div>
        )}
        {devices !== null && devices.length > 0 && (
          <div className="space-y-2">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                readOnly={!canManage}
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

function DeviceRow({ device, readOnly = false, onPatch, onDisable }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(device.label)
  const [deviceGroup, setDeviceGroup] = useState(device.device_group || '')
  const [mode, setMode] = useState(device.default_mode || 'cool')
  const [tempC, setTempC] = useState(device.default_temp_c ?? 22)
  const [fan, setFan] = useState(device.default_fan || 'auto')
  const [sessionMinutes, setSessionMinutes] = useState(device.session_minutes ?? 30)
  // STUDIO-AC-EXTERNAL-RULE.1 — '' (empty input) means "off". Any
  // positive integer is the cap in minutes. The PATCH route
  // coerces both to a clean integer or null.
  const [externalOff, setExternalOff] = useState(
    device.external_auto_off_minutes == null ? '' : String(device.external_auto_off_minutes)
  )

  function reset() {
    setLabel(device.label)
    setDeviceGroup(device.device_group || '')
    setMode(device.default_mode || 'cool')
    setTempC(device.default_temp_c ?? 22)
    setFan(device.default_fan || 'auto')
    setSessionMinutes(device.session_minutes ?? 30)
    setExternalOff(device.external_auto_off_minutes == null ? '' : String(device.external_auto_off_minutes))
  }

  async function save() {
    await onPatch({
      label: label.trim() || device.label,
      // Send empty string and let the server normalise to null. The
      // PATCH handler treats null as "clear the group".
      device_group: deviceGroup.trim(),
      default_mode: mode,
      default_temp_c: Number(tempC),
      default_fan: fan,
      session_minutes: Number(sessionMinutes),
      // Send the raw value. The PATCH handler coerces '' / null to
      // null (disable rule), positive int to int.
      external_auto_off_minutes: externalOff === '' ? null : Number(externalOff),
    })
    setEditing(false)
  }

  return (
    <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-un1t-text truncate">{device.label}</span>
            <span className="text-[10px] uppercase tracking-wider text-un1t-muted font-mono">
              {device.provider === 'thinq' ? 'LG ThinQ' : 'Sensibo'}
            </span>
            {device.device_group && (
              <span className="text-[10px] uppercase tracking-wider text-blue-700 bg-blue-500/15 px-1.5 py-0.5 rounded">
                {device.device_group}
              </span>
            )}
            {!device.enabled && (
              <span className="text-[10px] uppercase tracking-wider text-red-400">disabled</span>
            )}
          </div>
          <div className="text-[11px] text-un1t-subtle mt-0.5">
            Default: {device.default_mode} · {device.default_temp_c}°C · fan {device.default_fan} · {device.session_minutes} min
          </div>
          <div className="text-[11px] text-un1t-subtle mt-0.5">
            External auto-off:{' '}
            {device.external_auto_off_minutes == null
              ? <span className="text-un1t-muted">off</span>
              : <span className="text-blue-300">{device.external_auto_off_minutes} min</span>}
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => { reset(); setEditing(!editing) }}
              className="text-un1t-subtle hover:text-un1t-text"
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
        )}
      </div>

      {editing && !readOnly && (
        <div className="mt-3 pt-3 border-t border-un1t-border/40 space-y-2">
          <Field label="Label">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </Field>
          <Field
            label="Group"
            hint="Devices with the same group render together on the control panel (e.g. 'Gym Floor', 'Bathrooms'). Leave blank to show under 'Other'."
          >
            <input
              type="text"
              value={deviceGroup}
              onChange={(e) => setDeviceGroup(e.target.value)}
              placeholder="e.g. Bathrooms"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </Field>
          <div className="grid grid-cols-4 gap-2">
            <Field label="Mode">
              <select value={mode} onChange={(e) => setMode(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text">
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
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text" />
            </Field>
            <Field label="Fan">
              <select value={fan} onChange={(e) => setFan(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text">
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
            <Field label="Session (min)">
              <input type="number" min={5} max={720} value={sessionMinutes}
                onChange={(e) => setSessionMinutes(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text" />
            </Field>
          </div>
          <Field
            label="External auto-off (min)"
            hint="Cap how long this unit may run when started outside the CRM (LG remote, Sensibo app, wall panel). Leave empty to disable the rule for this device."
          >
            <input
              type="number"
              min={5}
              max={720}
              value={externalOff}
              onChange={(e) => setExternalOff(e.target.value)}
              placeholder="off"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { reset(); setEditing(false) }}
              className="text-xs text-un1t-subtle hover:text-un1t-text px-3 py-1.5">
              Cancel
            </button>
            <button type="button" onClick={save}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg text-xs font-semibold hover:bg-un1t-accent">
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
      <label className="block text-xs text-un1t-subtle mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-muted mt-1">{hint}</p>}
    </div>
  )
}

