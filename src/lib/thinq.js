// LG ThinQ Connect API client wrapper.
//
// API docs: https://thinq.developer.lge.com/en/cloud/docs/thinq-connect/
// Auth: Personal Access Token (PAT) generated at
//   https://connect-pat.lgthinq.com/. Long-lived; revocable by the
//   account owner from the same portal.
// Country code: 'IE' for UN1T Dublin. LG routes traffic to the
//   regional cluster (eic for Europe) using the X-Country header
//   on every request, NOT via the base URL — the SDK uses a single
//   base URL and LG dispatches internally.
//
// We only use a small subset of the API:
//   - listDevices()                  discovery for the settings UI
//   - getDeviceState(deviceId)        read current state
//   - setDeviceState(deviceId, body)  send a control command
//   - turnOff(deviceId)               convenience wrapper
//
// Every call carries an 8s timeout (matching src/lib/sensibo.js)
// and surfaces LG's error.code + error.message verbatim so the
// operator gets a clear "LG says: ..." error from the UI.
//
// Why we built our own HTTP wrapper rather than using the official
// pythinqconnect SDK:
//   - SDK is Python-only; the CRM is Node.js
//   - REST surface we need is narrow (4 endpoints)
//   - Direct fetch lets us own timeout + error semantics
//   - We can run on Vercel serverless without a Python runtime

const API_BASE = 'https://api-eic.lgthinq.com'
const REQUEST_TIMEOUT_MS = 8000

// LG's public client key — required on every Connect API call as the
// `x-api-key` header. Same value across all PAT clients (it identifies
// the Connect program, not the individual integration). Verified
// against the official Python SDK's const.py
// (https://github.com/thinq-connect/pythinqconnect/blob/main/thinqconnect/const.py).
// Without this header — or with a wrong value — LG returns 401
// regardless of how valid the PAT itself is.
const THINQ_API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3'

// LG's control-body enumeration. Sensibo uses lowercase 'cool',
// 'heat', etc., and per-device defaults in the CRM use that same
// vocabulary (the ac_devices.default_mode column has a CHECK
// constraint enforcing it). buildTurnOnState upcases the chosen
// values into the LG-specific shape.
const MODE_MAP = {
  cool: 'COOL',
  heat: 'HEAT',
  auto: 'AUTO',
  fan:  'FAN',
  dry:  'DRY',
}

// Sensibo's fan vocabulary is wider than LG's (low/medium/high vs
// LOW/MID/HIGH plus quiet/strong which LG doesn't expose). We map
// liberally: quiet → LOW, strong → HIGH. That matches what the
// LG remote does when the user picks the closest equivalent.
const FAN_MAP = {
  auto:   'AUTO',
  low:    'LOW',
  medium: 'MID',
  high:   'HIGH',
  quiet:  'LOW',
  strong: 'HIGH',
}

export class ThinqError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ThinqError'
    this.status = opts.status
    this.code   = opts.code
    this.body   = opts.body
  }
}

function requirePat(pat) {
  if (!pat || typeof pat !== 'string' || pat.trim() === '') {
    throw new ThinqError('LG ThinQ PAT is missing — configure it in Location settings.')
  }
  return pat
}

function requireClientId(clientId) {
  if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
    throw new ThinqError('LG ThinQ client_id is missing — configure it in Location settings.')
  }
  return clientId
}

// crypto.randomUUID is available in Node 19+ and the Edge / Vercel
// runtime. Used for X-Message-ID which LG asks for per-request to
// help trace problems on their side.
function newMessageId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: 32 random hex chars in uuid layout. Quality not
  // critical for a trace-id header.
  const r = (n) => Math.floor(Math.random() * n)
  const hex = (n) => r(n).toString(16).padStart(n.toString(16).length, '0')
  return `${hex(0x100000000)}-${hex(0x10000)}-4${hex(0x1000).slice(1)}-${hex(0x10000)}-${hex(0x100000000)}${hex(0x10000)}`
}

async function thinqFetch(path, {
  pat,
  clientId,
  countryCode = 'IE',
  method = 'GET',
  body,
  query = {},
  // Additional headers merged on top of the standard set. Used by
  // setDeviceState to add `x-conditional-control: true` — without
  // that header LG rejects every composite control payload
  // (anything that sets more than one resource in a single body)
  // with code 2207 'Invalid command error'.
  extraHeaders = null,
} = {}) {
  requirePat(pat)
  requireClientId(clientId)

  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v))
  }

  // Header casing matches the official Python SDK exactly. HTTP
  // headers are case-insensitive per spec, but LG's gateway is strict
  // — uppercase variants 401 even with a valid PAT + API key.
  // x-service-phase: 'OP' is the production phase marker; missing
  // this header also returns 401 from LG even though it's not
  // documented in the public API reference.
  const headers = {
    Authorization:      `Bearer ${pat}`,
    'x-country':        countryCode,
    'x-client-id':      clientId,
    'x-message-id':     newMessageId(),
    'x-api-key':        THINQ_API_KEY,
    'x-service-phase':  'OP',
    Accept:             'application/json',
    ...(extraHeaders || {}),
  }
  const init = {
    method,
    headers,
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
    throw new ThinqError(`LG ThinQ network error: ${e?.message || 'unknown'}`, { status: 0 })
  }

  const text = await resp.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = null }

  // LG envelopes responses as { messageId, timestamp, response, ... }
  // on success and adds an `error: { code, message }` on failure.
  // Both 4xx/5xx HTTP status AND a non-null error block at HTTP 200
  // count as failure. The latter is rare but documented.
  const hasError = json && json.error && (json.error.code || json.error.message)
  if (!resp.ok || hasError) {
    const code = json?.error?.code || null
    const msg = json?.error?.message
      || json?.message
      || `LG ThinQ ${resp.status}: ${text.slice(0, 200)}`
    throw new ThinqError(msg, { status: resp.status, code, body: json ?? text })
  }

  return json
}

// ── Devices ──────────────────────────────────────────────────────

/**
 * List all devices on the LG ThinQ account, filtered to air
 * conditioners. The CRM has no use for washers/dryers/etc. via
 * this integration — the discovery UI is AC-only.
 *
 * Returned shape:
 *   [{ device_id, alias, model, device_type, raw }, ...]
 *
 * The `alias` is the user-set name in the LG ThinQ app — that's
 * what becomes the default CRM label when the master picks the
 * device from the discovery list.
 */
export async function listDevices({ pat, clientId, countryCode } = {}) {
  const json = await thinqFetch('/devices', { pat, clientId, countryCode })
  const devices = json?.response || []
  return devices
    .filter((d) => d?.deviceInfo?.deviceType === 'DEVICE_AIR_CONDITIONER')
    .map((d) => ({
      device_id:   d.deviceId,
      alias:       d.deviceInfo?.alias || null,
      model:       d.deviceInfo?.modelName || null,
      device_type: d.deviceInfo?.deviceType || null,
      raw:         d,
    }))
}

// ── State ────────────────────────────────────────────────────────

/**
 * Read the device's current state. LG returns a nested resource
 * map; we flatten the bits the CRM cares about into a shape
 * roughly parallel to Sensibo's acState.
 *
 * Returned shape (or null if response is missing):
 *   {
 *     on:             boolean,
 *     mode:           'cool'|'heat'|'auto'|'fan'|'dry'|null,
 *     target_temp_c:  number|null,
 *     current_temp_c: number|null,
 *     fan:            'auto'|'low'|'medium'|'high'|null,
 *     raw:            object,   // the unmodified LG body
 *   }
 */
export async function getDeviceState(deviceId, { pat, clientId, countryCode } = {}) {
  if (!deviceId) throw new ThinqError('deviceId is required.')
  const json = await thinqFetch(
    `/devices/${encodeURIComponent(deviceId)}/state`,
    { pat, clientId, countryCode }
  )
  return normaliseState(json?.response || null)
}

function normaliseState(r) {
  if (!r || typeof r !== 'object') return null
  const opMode = r.operation?.airConOperationMode || null
  const job    = r.airConJobMode?.currentJobMode || null
  const tempC  = r.temperature?.targetTemperatureC ?? null
  const cur    = r.temperature?.currentTemperatureC ?? null
  const wind   = r.airFlow?.windStrength || null

  return {
    on:             opMode === 'POWER_ON',
    mode:           lowerEnum(job),
    target_temp_c:  toNum(tempC),
    current_temp_c: toNum(cur),
    fan:            lowerFanEnum(wind),
    raw:            r,
  }
}

function lowerEnum(v) {
  if (!v || typeof v !== 'string') return null
  return v.toLowerCase()
}

function lowerFanEnum(v) {
  if (!v || typeof v !== 'string') return null
  // LG returns 'MID' where Sensibo uses 'medium' — normalise so
  // the CRM speaks one language across vendors.
  const lower = v.toLowerCase()
  return lower === 'mid' ? 'medium' : lower
}

function toNum(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Control ──────────────────────────────────────────────────────

// Order matters for the sequential POST path below. LG needs to
// see POWER_ON before it will accept job-mode / temperature / fan
// for a unit that's currently off — settings on a powered-down
// device return code 2207 'Invalid command error'. After that the
// remaining resources can be sent in any order; we keep a stable
// sequence so logs are predictable.
const CONTROL_SEQUENCE = ['operation', 'airConJobMode', 'temperature', 'airFlow']

/**
 * Send a control command.
 *
 * IMPORTANT: LG's /control endpoint silently rejects bodies that
 * touch more than one resource block — every composite payload
 * returns code 2207 'Invalid command error', regardless of the
 * `x-conditional-control` header. Verified against the official
 * Python SDK (thinq-connect/pythinqconnect): every "set" method on
 * AirConditionerDevice (operation, job mode, temperature, fan)
 * goes through `do_attribute_command` or `do_enum_attribute_command`
 * which fire one POST per attribute. They never combine.
 *
 * So when the caller passes a composite body (e.g. buildTurnOnState
 * which sets operation + airConJobMode + temperature + airFlow),
 * we split it into N POSTs and fire them sequentially. The last
 * response's state is returned, normalised. Single-resource bodies
 * (e.g. turnOff sending just `operation`) pass through unchanged.
 */
export async function setDeviceState(deviceId, command, { pat, clientId, countryCode } = {}) {
  if (!deviceId) throw new ThinqError('deviceId is required.')
  if (!command || typeof command !== 'object') {
    throw new ThinqError('command body is required.')
  }

  // Build the ordered list of single-resource bodies. Resources
  // mentioned in CONTROL_SEQUENCE come first in that order; anything
  // else (defensive — we don't currently send anything outside the
  // sequence) follows. Skip empty / null sub-objects so the
  // dispatcher's buildTurnOnState callers stay loose.
  const keys = [
    ...CONTROL_SEQUENCE.filter((k) => command[k] && typeof command[k] === 'object'),
    ...Object.keys(command).filter(
      (k) => !CONTROL_SEQUENCE.includes(k) && command[k] && typeof command[k] === 'object'
    ),
  ]
  if (keys.length === 0) {
    throw new ThinqError('command body has no resource keys.')
  }

  let lastJson = null
  for (const key of keys) {
    const body = { [key]: command[key] }
    lastJson = await thinqFetch(
      `/devices/${encodeURIComponent(deviceId)}/control`,
      {
        pat,
        clientId,
        countryCode,
        method: 'POST',
        body,
        // The header doesn't hurt for single-resource POSTs either,
        // and keeping it on every call matches the Python SDK's
        // posture (they include it unconditionally).
        extraHeaders: { 'x-conditional-control': 'true' },
      }
    )
  }

  // LG's control response sometimes echoes the new state, sometimes
  // returns an empty success envelope. Callers that need the new
  // state should do a follow-up getDeviceState() — we surface
  // whatever LG returned on the LAST call (typically the airFlow
  // POST), normalised, or null.
  return normaliseState(lastJson?.response || null)
}

/**
 * Convenience: turn the device off. LG only requires the operation
 * block for a power-off — the other resources are accepted but
 * ignored when going to POWER_OFF, so we send a minimal command.
 */
export async function turnOff(deviceId, { pat, clientId, countryCode } = {}) {
  return setDeviceState(
    deviceId,
    { operation: { airConOperationMode: 'POWER_OFF' } },
    { pat, clientId, countryCode }
  )
}

/**
 * Build the LG-shaped "turn on" command from CRM-side defaults.
 * Inputs use the same lowercase vocabulary as Sensibo + the
 * ac_devices.default_mode column ('cool'/'heat'/'auto'/'fan'/'dry')
 * — this function upcases them into LG's enum.
 *
 * Centralised here so the API route + the cron + the tests all
 * agree on the shape.
 */
export function buildTurnOnState({ mode, tempC, fan } = {}) {
  const lgMode = MODE_MAP[String(mode || 'cool').toLowerCase()] || 'COOL'
  const lgFan  = FAN_MAP[String(fan || 'auto').toLowerCase()] || 'AUTO'
  const t = tempC == null ? 22 : Number(tempC)
  return {
    operation:      { airConOperationMode: 'POWER_ON' },
    airConJobMode:  { currentJobMode: lgMode },
    temperature:    { targetTemperatureC: t },
    airFlow:        { windStrength: lgFan },
  }
}
