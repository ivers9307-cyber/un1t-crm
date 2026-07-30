'use client'

// GEO-ATT.5 — per-location mobile geofence attendance card.
//
// Operator card (Settings → Locations → <name> → Details, below
// CommsFrequencyCapCard): enable toggle + gym coordinates + radius +
// the permission-gate copy staff see on mobile. OFF by default. When
// enabled, the CRM mobile app blocks staff at this location behind a
// background-location ("Always") permission screen and auto-stamps
// shift arrivals when their phone enters the geofence
// (source='geofence', mig 463). Exempt staff (per-assignment toggle in
// the staff editor) are never gated or stamped.
//
// Reads + writes via /api/locations/[id]/geofence-attendance.

import { useEffect, useState } from 'react'
import { MapPin, Loader2, Check, AlertTriangle } from 'lucide-react'
import GeofenceMapPicker from './GeofenceMapPicker'
import {
  DEFAULT_GATE_COPY,
  GEOFENCE_MIN_RADIUS_M,
  GEOFENCE_MAX_RADIUS_M,
} from '@/lib/geofence-attendance'

// The GET always echoes the effective gate copy — when it's the
// default, keep the textarea blank so "blank = default" stays true.
function fromApi(d) {
  return {
    enabled: d.enabled,
    lat: d.latitude === null ? '' : String(d.latitude),
    lng: d.longitude === null ? '' : String(d.longitude),
    radius: d.radius_m,
    gateCopy: d.gate_copy === DEFAULT_GATE_COPY ? '' : (d.gate_copy || ''),
  }
}

export default function GeofenceAttendanceCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState(150)
  const [gateCopy, setGateCopy] = useState('')
  const [saved, setSaved] = useState({ enabled: false, lat: '', lng: '', radius: 150, gateCopy: '' })
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  function applyState(s) {
    setEnabled(s.enabled)
    setLat(s.lat)
    setLng(s.lng)
    setRadius(s.radius)
    setGateCopy(s.gateCopy)
    setSaved(s)
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/locations/${locationId}/geofence-attendance`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success) {
          setError(j.error || `HTTP ${res.status}`)
        } else {
          const s = fromApi(j.data)
          setEnabled(s.enabled)
          setLat(s.lat)
          setLng(s.lng)
          setRadius(s.radius)
          setGateCopy(s.gateCopy)
          setSaved(s)
          setCanEdit(!!j.data.can_edit)
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  const radiusNum = Number(radius)
  const radiusValid = Number.isInteger(radiusNum)
    && radiusNum >= GEOFENCE_MIN_RADIUS_M
    && radiusNum <= GEOFENCE_MAX_RADIUS_M
  const latNum = lat === '' ? null : Number(lat)
  const lngNum = lng === '' ? null : Number(lng)
  const latValid = latNum === null ? !enabled : (Number.isFinite(latNum) && latNum >= -90 && latNum <= 90)
  const lngValid = lngNum === null ? !enabled : (Number.isFinite(lngNum) && lngNum >= -180 && lngNum <= 180)
  const valid = radiusValid && latValid && lngValid
  const dirty = enabled !== saved.enabled
    || lat !== saved.lat
    || lng !== saved.lng
    || radiusNum !== saved.radius
    || gateCopy !== saved.gateCopy

  async function save() {
    if (!valid || saving) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/geofence-attendance`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled,
          latitude: latNum,
          longitude: lngNum,
          radius_m: radiusNum,
          gate_copy: gateCopy.trim() ? gateCopy.trim() : null,
        }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
      } else {
        applyState(fromApi(j.data))
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
      }
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading geofence attendance…
      </div>
    )
  }

  return (
    <section className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2">
            <MapPin size={14} className="text-un1t-subtle" />
            <h4 className="text-sm font-semibold text-un1t-text">Geofence attendance</h4>
          </div>
          <p className="text-xs text-un1t-subtle mt-1 max-w-md">
            When enabled, the staff mobile app detects arrival at the gym and
            stamps shift attendance automatically. Staff at this location must
            grant &quot;Always&quot; location access before they can use the app
            (exempt them per person in the staff editor).
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable geofence attendance"
            onClick={() => setEnabled(v => !v)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
              enabled ? 'bg-un1t-text' : 'bg-un1t-border'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-un1t-bg transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        )}
      </div>

      <div className="mt-3">
        <GeofenceMapPicker
          latitude={latValid && latNum !== null ? latNum : null}
          longitude={lngValid && lngNum !== null ? lngNum : null}
          radiusM={radiusValid ? radiusNum : 0}
          interactive={canEdit}
          onPick={({ latitude, longitude }) => {
            setLat(String(latitude))
            setLng(String(longitude))
          }}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 max-w-md">
        <div>
          <label htmlFor="geo-att-lat" className="block text-xs text-un1t-subtle mb-1">Latitude</label>
          <input
            id="geo-att-lat"
            type="number"
            step="0.000001"
            min={-90}
            max={90}
            placeholder="53.290500"
            value={lat}
            disabled={!canEdit}
            onChange={(e) => setLat(e.target.value)}
            className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
          />
        </div>
        <div>
          <label htmlFor="geo-att-lng" className="block text-xs text-un1t-subtle mb-1">Longitude</label>
          <input
            id="geo-att-lng"
            type="number"
            step="0.000001"
            min={-180}
            max={180}
            placeholder="-6.198800"
            value={lng}
            disabled={!canEdit}
            onChange={(e) => setLng(e.target.value)}
            className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
          />
        </div>
      </div>
      <p className="mt-1 text-xs text-un1t-muted">
        Fine-tune the exact coordinates here if needed — the map and fields stay in sync
      </p>
      {(!latValid || !lngValid) && (
        <p className="mt-1 text-xs text-red-700">
          {enabled && (latNum === null || lngNum === null)
            ? 'Latitude and longitude are required when geofencing is enabled.'
            : 'Latitude must be between -90 and 90; longitude between -180 and 180.'}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs text-un1t-text">
        <label htmlFor="geo-att-radius" className={enabled ? '' : 'text-un1t-subtle'}>
          Radius (m)
        </label>
        <input
          id="geo-att-radius"
          type="number"
          min={GEOFENCE_MIN_RADIUS_M}
          max={GEOFENCE_MAX_RADIUS_M}
          step={1}
          value={radius}
          disabled={!canEdit}
          onChange={(e) => setRadius(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-24 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        />
        <span className="text-un1t-muted">({GEOFENCE_MIN_RADIUS_M}–{GEOFENCE_MAX_RADIUS_M})</span>
      </div>
      {!radiusValid && (
        <p className="mt-1 text-xs text-red-700">
          Radius must be a whole number between {GEOFENCE_MIN_RADIUS_M} and {GEOFENCE_MAX_RADIUS_M} metres.
        </p>
      )}

      <div className="mt-3">
        <label htmlFor="geo-att-gate-copy" className="block text-xs text-un1t-subtle mb-1">
          Permission-gate copy
        </label>
        <textarea
          id="geo-att-gate-copy"
          rows={3}
          maxLength={2000}
          value={gateCopy}
          disabled={!canEdit}
          placeholder={DEFAULT_GATE_COPY}
          onChange={(e) => setGateCopy(e.target.value)}
          className="w-full max-w-md rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        />
        <p className="mt-1 text-xs text-un1t-muted">
          Shown to staff when the app asks for Always location. Leave blank for the default.
        </p>
      </div>

      {error && (
        <div className="mt-2 text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || !valid || saving}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
          </button>
          {savedFlash && (
            <span className="inline-flex items-center gap-1 text-xs text-green-700">
              <Check size={12} /> Saved
            </span>
          )}
        </div>
      )}
    </section>
  )
}
