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
import { resolveGeofencePermission } from './geofence-permission'

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

function newItemId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// Items queued before ARRIVAL.2 have no id; their location + time is unique enough.
const itemKey = (item) => item?.id || `${item?.location_id}|${item?.entered_at}`

export async function enqueueCheckin(locationId) {
  const q = await readQueue()
  q.push({ id: newItemId(), location_id: locationId, entered_at: new Date().toISOString() })
  await writeQueue(q)
}

/** POST one queued check-in. Returns true when it should stay queued. */
async function shouldKeep(item) {
  try {
    const res = await api('/api/attendance/geofence-checkin', {
      method: 'POST',
      locationId: item.location_id,
      body: item,
    })
    // Server-rejected (4xx → success:false with a real error) is
    // terminal — retrying an exempt/disabled ping forever is noise.
    // Transient failures stay queued, via three channels:
    //   1. api()'s own envelopes, tagged transport:true (SONOSMOB.4c):
    //      a dropped fetch (no status) or a non-JSON body (status
    //      carried). Only a non-JSON 5xx is transient — an edge error
    //      page; a non-JSON 4xx is an HTML 404 off a wrong base URL and
    //      retrying it forever is the noise this guard exists to stop.
    //      GEOFENCE-TRANSPORT.1 — this used to regex the error STRING
    //      ("^Network error", "^Non-JSON response \(5\d\d\)"), which
    //      silently stops matching if api() ever rewords its message.
    //   2. "HTTP 5xx" for a bare non-2xx JSON without our envelope —
    //      that one reached the server, so api() deliberately leaves it
    //      untagged and the status lives only in the string.
    //   3. The checkin route's own 503s carry transient:true in the
    //      envelope (their error string is a raw DB message, so it
    //      can't be sniffed) — api() passes the flag through verbatim.
    const transportBlip =
      res.transport === true && !(res.status >= 400 && res.status < 500)
    return !res.success && (
      res.transient === true ||
      transportBlip ||
      /^HTTP 5\d\d/.test(res.error || '')
    )
  } catch {
    return true
  }
}

let drainGeneration = 0

async function drainQueue(generation) {
  // ARRIVAL.2 — a second pass picks up check-ins enqueued while the first was
  // posting. Three passes bound the loop if the phone keeps re-entering.
  for (let pass = 0; pass < 3; pass++) {
    // ARRIVAL.2 review round 2 — a drain that lost the race to the budget
    // timer (see runDrainWithBudget) keeps running in the background; its
    // caller has already moved on and possibly started a NEWER drain. This
    // stale drain must never write — worst case an item it already posted
    // stays queued and gets re-posted next pass, a duplicate the server
    // dedups, which beats it clobbering state a newer drain just wrote.
    if (generation !== drainGeneration) return
    const q = await readQueue()
    if (q.length === 0) return
    const taken = new Set(q.map(itemKey))
    const remaining = []
    for (const item of q) {
      if (await shouldKeep(item)) remaining.push(item)
    }
    if (generation !== drainGeneration) return
    // Re-read before writing: the old code wrote `remaining` over the queue
    // and silently dropped anything the background task added meanwhile.
    const latest = await readQueue()
    const added = latest.filter((item) => !taken.has(itemKey(item)))
    await writeQueue([...remaining, ...added])
    if (added.length === 0) return
  }
}

const FLUSH_BUDGET_MS = 25_000

let inFlight = null
// A flushQueue() call that arrives while a drain is already running sets
// this instead of starting a second one; the running drain checks it once
// it finishes and, if set, runs exactly one more pass before resolving —
// so a caller that enqueued late still gets its item posted in THIS call,
// not stranded until the next unrelated flush. One flag, not a counter:
// any number of calls arriving mid-drain coalesce into a single follow-up.
let rerunRequested = false

async function runDrainWithBudget(budgetMs) {
  for (;;) {
    // A fresh generation per drain attempt — including a rerun pass, which
    // must NOT reuse the generation it's replacing (it is the current
    // legitimate drain, not the stale one the budget timer walked away
    // from).
    const generation = ++drainGeneration
    let timer
    const budget = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs) })
    try {
      // api() has no timeout of its own, so a stuck POST (the OS suspending
      // the app mid-fetch is the real case) would otherwise wedge
      // drainQueue() forever — and every caller shares this one promise, so
      // a hang here would stall syncGeofences (which awaits the flush
      // before region sync) and LocationGate right along with it. Racing a
      // budget means the abandoned drain's eventual write can still land
      // after we've moved on; that's an accepted rare duplicate post, and
      // the server dedups it — the generation check above just keeps it
      // from overwriting whatever a newer drain wrote in the meantime.
      await Promise.race([drainQueue(generation), budget])
    } finally {
      clearTimeout(timer)
    }
    if (!rerunRequested) return
    rerunRequested = false
  }
}

/**
 * POST every queued check-in; keep whatever still fails.
 * ARRIVAL.2 — single-flight. Four callers can flush at once (the background
 * task, syncGeofences, the app layout and LocationGate); running them in
 * parallel posted the same arrival twice, 100 ms apart, which is how one
 * arrival stamped two shifts on 16 Sep. Every caller now awaits one drain.
 * This only coalesces callers inside THIS JS runtime — an Android headless
 * task runs in a separate JS context from the foreground app, so duplicates
 * across the two are not deduped here; that's the server's job (PR #1694).
 * `budgetMs` is for tests only; real callers never pass it.
 */
export function flushQueue({ budgetMs = FLUSH_BUDGET_MS } = {}) {
  if (inFlight) {
    rerunRequested = true
    return inFlight
  }
  inFlight = runDrainWithBudget(budgetMs).finally(() => { inFlight = null })
  return inFlight
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

  // GEO-ATT.17 — paired studio kiosks never take part in geofence
  // attendance. Same carve-out push-register.js already applies to push
  // tokens, and for the same reason: a kiosk is a SHARED gym device.
  // It sits permanently inside the gym's region, so an ENTER delivered
  // after a reboot or a re-registration would stamp the arrival of
  // whichever staff member's session the kiosk happens to hold — a
  // person who may be at home. It also must never be permission-gated:
  // a reception iPad without "Always" location would otherwise be
  // blocked out of the app entirely (LocationGate applies the same
  // guard). Returning null leaves any prior registration untouched;
  // a device only becomes a kiosk deliberately, via pairing.
  try {
    const { getPairing } = await import('./studio-device')
    if (await getPairing()) return null
  } catch { /* SecureStore unreadable ⇒ treat as unpaired */ }

  // GEO-ATT.12 — drain the retry queue on every sync (auth bootstrap +
  // every foreground), not just inside the background task: a ping that
  // failed while the phone had no signal would otherwise sit queued
  // until the NEXT region ENTER. After the impersonation guard on
  // purpose — flushing mid-View-as would post the master's own queued
  // pings with the impersonation header and the server would drop them
  // (impersonation_ignored); they survive until View-as ends instead.
  // Own try/catch: a queue failure must never block region sync.
  try { await flushQueue() } catch {}

  const res = await api('/api/attendance/geofence-config')
  if (!res.success || !res.data) return null
  const { required, regions } = res.data

  // GEO-ATT.21 — same resolver LocationGate uses. It used to be a local
  // `catch { granted = false }` here while the gate did `setGranted(true)`, so
  // one throw tore the registration down AND hid the screen that would have
  // told the staffer. mayRegister is false for every non-granted state,
  // including the error: we never claim a permission we could not read.
  let granted = false
  try {
    const bg = await Location.getBackgroundPermissionsAsync()
    granted = resolveGeofencePermission({ bg }).mayRegister
  } catch (e) {
    granted = resolveGeofencePermission({ error: e }).mayRegister
  }

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
