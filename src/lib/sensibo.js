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
// Every call carries an 8s timeout and surfaces the API's
// status_code/message verbatim so the operator gets a clear
// "Sensibo says: ..." error from the UI.

const API_BASE = 'https://home.sensibo.com/api/v2'
const REQUEST_TIMEOUT_MS = 8000

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
  let resp
  try {
    resp = await fetch(url, init)
  } catch (e) {
    throw new SensiboError(`Sensibo network error: ${e?.message || 'unknown'}`, { status: 0 })
  }
  const text = await resp.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!resp.ok || (json && json.status === 'failure')) {
    const msg = json?.message || json?.reason || `Sensibo ${resp.status}: ${text.slice(0, 200)}`
    throw new SensiboError(msg, { status: resp.status, body: json ?? text })
  }
  return json
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
 * Convenience: turn the pod off. Reads the current state, flips
 * `on` to false, posts back. We preserve the rest so the next
 * "turn on" doesn't suddenly come up at the wrong target temp.
 */
export async function turnPodOff(apiKey, podId) {
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
