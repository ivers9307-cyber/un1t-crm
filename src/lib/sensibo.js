// Sensibo API v2 client wrapper.
//
// API docs: https://sensibo.github.io/
// Auth: ?apiKey=xxx as a query string param on every request.
// All endpoints are under https://home.sensibo.com/api/v2/.
//
// We only use a small subset:
//   - listPods()                       discovery for the settings UI
//   - getPodState(podId)               read current acState
//   - setPodState(podId, partial)      patch acState (on/off, mode, etc.)
//   - turnOff(podId)                   convenience wrapper around setPodState
//
// Every call carries a timeout and surfaces the API's
// status_code/message verbatim so the operator gets a clear
// "Sensibo says: ..." error from the UI.
//
// SENSIBO-RATE.1 — every request goes through `sensiboLimiter`,
// which spaces calls and retries 429s. Sensibo rate-limits on
// BURSTS (~4 calls in 1.6s = 429, block >75s) rather than on
// volume, and an unspaced client is what left the gym-floor AC
// running past its auto-off from 2026-08-29. See sensibo-limiter.js
// for the measurements and for why the cron stagger in vercel.json
// is required alongside this.

import { sensiboLimiter } from '@/lib/sensibo-limiter'

const API_BASE = 'https://home.sensibo.com/api/v2'
// Raised from 8s: a Sensibo POST waits on the pod acknowledging the
// IR command, and 8s was clipping slow-but-fine calls into what
// looked like a network fault.
const REQUEST_TIMEOUT_MS = 12000

export class SensiboError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'SensiboError'
    this.status = opts.status
    this.body = opts.body
  }
}

function requireApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new SensiboError('Sensibo API key is missing — configure it in Location settings.')
  }
  return apiKey
}

async function sensiboFetch(path, { apiKey, method = 'GET', body, query = {} } = {}) {
  requireApiKey(apiKey)
  const url = new URL(`${API_BASE}${path}`)
  url.searchParams.set('apiKey', apiKey)
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v))
  }
  const init = {
    method,
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  // Queued so two Sensibo calls never go out back-to-back, and so a
  // 429 is retried with jittered backoff rather than surfacing as a
  // dead AC. The whole request — including reading the body — sits
  // inside the scheduled unit so a retry re-runs all of it.
  return sensiboLimiter.schedule(async () => {
    let resp, text
    try {
      resp = await fetch(url, init)
      // Reading the body used to sit OUTSIDE this try, so an abort
      // during the read escaped as a raw AbortError instead of a
      // SensiboError — unclassifiable by the limiter and confusing
      // in failure_reason. It's inside now.
      text = await resp.text()
    } catch (e) {
      throw new SensiboError(`Sensibo network error: ${e?.message || 'unknown'}`, { status: 0 })
    }
    let json
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!resp.ok || (json && json.status === 'failure')) {
      const msg = json?.message || json?.reason || `Sensibo ${resp.status}: ${text.slice(0, 200)}`
      throw new SensiboError(msg, { status: resp.status, body: json ?? text })
    }
    return json
  })
}

// ── Pods (devices) ───────────────────────────────────────────────

/**
 * List all pods on the account. Returned pods have:
 *   { id, room: { name, icon }, productModel, qrId, acState, ... }
 * We surface the bits the settings UI needs (id, room name).
 */
export async function listPods(apiKey) {
  const json = await sensiboFetch('/users/me/pods', {
    apiKey,
    query: { fields: 'id,room,productModel,acState' },
  })
  // Sensibo returns { status: 'success', result: [...] }
  return (json?.result || []).map((p) => ({
    id: p.id,
    room_name: p.room?.name || null,
    product_model: p.productModel || null,
    on: p.acState?.on === true,
    mode: p.acState?.mode || null,
    target_temp: p.acState?.targetTemperature ?? null,
    fan_level: p.acState?.fanLevel || null,
    raw: p,
  }))
}

// ── State ────────────────────────────────────────────────────────

/**
 * Read the pod's current acState. Returns the inner state object
 * exactly as Sensibo exposes it:
 *   { on, mode, targetTemperature, temperatureUnit, fanLevel, swing, horizontalSwing }
 */
export async function getPodState(apiKey, podId) {
  if (!podId) throw new SensiboError('podId is required.')
  const json = await sensiboFetch(`/pods/${encodeURIComponent(podId)}`, {
    apiKey,
    query: { fields: 'acState' },
  })
  return json?.result?.acState || null
}

/**
 * Set the pod's acState. Sensibo wants the FULL state object on
 * /pods/{id}/acStates POST — partial PATCH semantics aren't
 * supported. So callers should pass the desired full state.
 *
 * Common shape:
 *   { on: true, mode: 'cool', targetTemperature: 18,
 *     temperatureUnit: 'C', fanLevel: 'high', swing: 'stopped' }
 *
 * Returns the resulting acState reported by Sensibo.
 */
export async function setPodState(apiKey, podId, acState) {
  if (!podId) throw new SensiboError('podId is required.')
  const body = { acState }
  const json = await sensiboFetch(
    `/pods/${encodeURIComponent(podId)}/acStates`,
    { apiKey, method: 'POST', body }
  )
  return json?.result?.acState || acState
}

/**
 * Convenience: turn the pod off.
 *
 * SENSIBO-RATE.1 — pass `offState` (from buildTurnOffState) and this
 * is ONE POST. Without it we fall back to the original read-then-
 * write, which is two calls.
 *
 * Halving this matters: the auto-off cron loops expired sessions and
 * did GET+POST per row, which is precisely the back-to-back pattern
 * Sensibo's burst limiter punishes.
 *
 * Dropping the read costs nothing. Its stated purpose was to
 * preserve mode/temp/fan "so the next turn on doesn't come up at the
 * wrong target temp" — but `vendorTurnOn` always rebuilds the state
 * from the device's stored defaults (ac_devices.default_*) and never
 * reads what we preserved. The read was writing back a value nobody
 * consumed.
 */
export async function turnPodOff(apiKey, podId, offState) {
  if (offState) return setPodState(apiKey, podId, { ...offState, on: false })
  const current = await getPodState(apiKey, podId)
  const next = { ...(current || {}), on: false }
  return setPodState(apiKey, podId, next)
}

/**
 * Convenience: build the "turn on" state from a location's defaults.
 * Centralised so the API route + the cron + the lib tests all
 * agree on the shape.
 */
export function buildTurnOnState({ mode, temp, fan }) {
  return {
    on: true,
    mode: mode || 'cool',
    targetTemperature: temp ?? 18,
    temperatureUnit: 'C',
    fanLevel: fan || 'high',
    swing: 'stopped',
  }
}

/**
 * The same full acState with the power off — Sensibo's POST
 * /acStates wants a complete state object, not a partial patch, so
 * we send the device's own defaults with `on: false` rather than
 * reading the live state back first. Built from the same defaults
 * `buildTurnOnState` uses, so on/off stay symmetric.
 */
export function buildTurnOffState({ mode, temp, fan }) {
  return { ...buildTurnOnState({ mode, temp, fan }), on: false }
}
