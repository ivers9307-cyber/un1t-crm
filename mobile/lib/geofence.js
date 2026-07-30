// mobile/lib/geofence.js
//
// GEO-ATT — passive attendance. Three responsibilities:
//   1. The background geofence task (module top-level defineTask so it
//      exists on headless relaunch — imported from app/_layout.jsx).
//   2. A SecureStore-backed retry queue: ENTER events enqueue first,
//      then flush; failed posts survive until the next foreground.
//   3. syncGeofences(): fetch /api/attendance/geofence-config and
//      (re)register OS regions when the set changed.
//
// The task fires with the app killed: it can rely on module-level
// imports (supabase session restores from SecureStore inside api())
// but NOT on React state or AuthContext.

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as SecureStore from 'expo-secure-store'
import { api } from './api'
import { readImpersonate } from './impersonate'

export const GEOFENCE_TASK = 'geo-att-region-enter'
const QUEUE_KEY = 'geo_att_queue_v1'
const REGIONS_KEY = 'geo_att_regions_v1'
const QUEUE_MAX = 10

async function readQueue() {
  try {
    const raw = await SecureStore.getItemAsync(QUEUE_KEY)
    const q = raw ? JSON.parse(raw) : []
    return Array.isArray(q) ? q : []
  } catch { return [] }
}

async function writeQueue(q) {
  try { await SecureStore.setItemAsync(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX))) } catch {}
}

export async function enqueueCheckin(locationId) {
  const q = await readQueue()
  q.push({ location_id: locationId, entered_at: new Date().toISOString() })
  await writeQueue(q)
}

/** POST every queued check-in; keep whatever still fails. */
export async function flushQueue() {
  const q = await readQueue()
  if (q.length === 0) return
  const remaining = []
  for (const item of q) {
    try {
      const res = await api('/api/attendance/geofence-checkin', {
        method: 'POST',
        locationId: item.location_id,
        body: item,
      })
      // Server-rejected (4xx → success:false with a real error) is
      // terminal — retrying an exempt/disabled ping forever is noise.
      // Transient failures stay queued, via two channels:
      //   1. api()-synthesised strings for network/edge failures
      //      ("Network error: …"; "Non-JSON response (5xx)" for HTML
      //      error pages; "HTTP 5xx" for bare non-2xx JSON) — see
      //      mobile/lib/api.js.
      //   2. The checkin route's own 503s carry transient:true in the
      //      envelope (their error string is a raw DB message, so it
      //      can't be sniffed) — api() passes the flag through verbatim.
      if (
        !res.success &&
        (res.transient === true ||
          /^Network error/.test(res.error || '') ||
          /^Non-JSON response \(5\d\d\)/.test(res.error || '') ||
          /^HTTP 5\d\d/.test(res.error || ''))
      ) remaining.push(item)
    } catch { remaining.push(item) }
  }
  await writeQueue(remaining)
}

// ── Background task — MUST be at module top level ──────────────────
TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return
  const { eventType, region } = data
  if (eventType !== Location.GeofencingEventType.Enter) return
  if (!region?.identifier) return
  // identifier carries the CRM location_id (set in syncGeofences).
  await enqueueCheckin(region.identifier)
  await flushQueue()
})

/**
 * Fetch config and (re)register regions. Call after auth bootstrap and
 * on foreground. Safe to call repeatedly — no-ops when nothing changed.
 * Returns the config so callers (the gate) can reuse it.
 */
export async function syncGeofences() {
  // GEO-ATT.10b — never touch region registration mid-impersonation:
  // the config fetch would run AS THE TARGET (x-impersonate-target
  // header), so a master viewing-as a gated staff member could register
  // the target's regions on their own phone and stamp the target's
  // attendance. Leave the master's own registration untouched too —
  // impersonation is a temporary lens, not a location change.
  try {
    const imp = await readImpersonate()
    if (imp?.targetId) return null
  } catch {}

  const res = await api('/api/attendance/geofence-config')
  if (!res.success || !res.data) return null
  const { required, regions } = res.data

  let granted = false
  try {
    const bg = await Location.getBackgroundPermissionsAsync()
    granted = bg.status === 'granted'
  } catch { granted = false }

  const fingerprint = JSON.stringify(
    (regions || []).map(r => [r.location_id, r.latitude, r.longitude, r.radius_m]).sort()
  )
  let prev = null
  try { prev = await SecureStore.getItemAsync(REGIONS_KEY) } catch {}

  try {
    if (!required || !granted || (regions || []).length === 0) {
      const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)
      if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK)
      await SecureStore.setItemAsync(REGIONS_KEY, '')
    } else {
      // Self-heal: even when the fingerprint matches, the OS-level
      // registration may have been torn down (e.g. TaskManager's
      // task-not-found path unregisters geofencing natively) — check
      // the actual registration, not just our stored fingerprint.
      const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)
      if (fingerprint !== prev || !started) {
        await Location.startGeofencingAsync(GEOFENCE_TASK, regions.map(r => ({
          identifier: r.location_id,
          latitude: r.latitude,
          longitude: r.longitude,
          radius: r.radius_m,
          notifyOnEnter: true,
          notifyOnExit: false,
        })))
        await SecureStore.setItemAsync(REGIONS_KEY, fingerprint)
      }
    }
  } catch {
    // Geofencing registration must never crash the app shell.
  }
  return res.data
}
