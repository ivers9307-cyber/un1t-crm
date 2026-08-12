// BRIDGE-BLIND.1 — parse the self-reported telemetry a champ-bridge sends on
// every heartbeat into the columns mig 531 added to `ble_bridges`.
//
// WHY THIS IS A SEPARATE, PURE MODULE
// The heartbeat route runs ~every 30s per bridge and must NEVER fail over a
// payload it does not like — a bridge that cannot heartbeat looks offline,
// which would turn a telemetry bug into a fake outage alert. So every decision
// about a hostile/odd payload is made here, in a function that cannot throw and
// that is exercised by unit tests rather than by prod.
//
// THE SHAPE, as actually sent (champ-bridge src/index.js buildTelemetry() +
// src/api.js postHeartbeat):
//
//   buildTelemetry() -> { pending_samples, adapters, uptime_s }
//   postHeartbeat()  -> Object.assign({ software_version, status }, telemetry)
//
// Note the second line: postHeartbeat SPREADS telemetry across the top level,
// so what arrives on the wire today is FLAT:
//
//   { software_version, status, pending_samples, uptime_s,
//     adapters: { ant: { protocol, fake, stick_present, seen },
//                 ble: { protocol, fake, powered_on, connections } } }
//
// A reasonable person reading buildTelemetry() alone would expect a nested
// `telemetry` key, and a future bridge might well send one. Both are accepted:
// nested wins when present, flat otherwise. Getting this wrong is silent — the
// columns would just stay NULL and the alerting built on them would never fire,
// which is the exact failure class this whole change exists to end.

/** Only an explicit `false` from the bridge counts as a fault. */
const ADAPTER_HEALTH_FIELD = {
  ant: 'stick_present', // is the ANT+ USB stick open and started?
  ble: 'powered_on',    // is the Bluetooth radio powered and scanning?
}

// Bounds on what we will store. The bridge is authenticated, but it is a box in
// a gym running software we also write — a bug there must not be able to grow
// a jsonb column without limit or push a value the `integer` columns cannot
// hold. Generous enough that the real payload (2 adapters, 4 fields each) is
// nowhere near them.
const MAX_ADAPTERS = 8
const MAX_ADAPTER_FIELDS = 16
const MAX_KEY_LENGTH = 32
const MAX_STRING_LENGTH = 64
const MAX_INT = 2_147_483_647 // int4, matching the columns mig 531 adds

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** Non-negative int32, or null for anything else. */
function clampInt(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(MAX_INT, Math.round(n)))
}

/**
 * Keep scalars, drop everything else. Returns `undefined` for "drop this key"
 * so a legitimately-null reported value is still distinguishable from absence.
 */
function sanitiseScalar(v) {
  if (v === null) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v.slice(0, MAX_STRING_LENGTH)
  return undefined
}

/** Whitelist-shaped copy of `adapters`: known-ish keys, scalar leaves only. */
function sanitiseAdapters(adapters) {
  const out = {}
  let adapterCount = 0
  for (const [name, value] of Object.entries(adapters)) {
    if (adapterCount >= MAX_ADAPTERS) break
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_KEY_LENGTH) continue
    if (!isPlainObject(value)) continue
    const fields = {}
    let fieldCount = 0
    for (const [k, v] of Object.entries(value)) {
      if (fieldCount >= MAX_ADAPTER_FIELDS) break
      if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY_LENGTH) continue
      const scalar = sanitiseScalar(v)
      if (scalar === undefined) continue
      fields[k] = scalar
      fieldCount++
    }
    out[name] = fields
    adapterCount++
  }
  return out
}

/**
 * Read one adapter's health flag.
 *
 * @returns {boolean|null} the reported boolean, or null for "did not say".
 *   NULL IS LOAD-BEARING: it means an older bridge, or an adapter that is not
 *   configured on this box, and it must never grade as a fault. Only `false`
 *   is a fault (see mig 531 and gradeDevice).
 */
export function adapterHealth(adapters, name) {
  const field = ADAPTER_HEALTH_FIELD[name]
  if (!field || !isPlainObject(adapters)) return null
  const reported = adapters[name]
  if (!isPlainObject(reported)) return null
  return typeof reported[field] === 'boolean' ? reported[field] : null
}

/**
 * Turn a heartbeat body into a partial `ble_bridges` patch, or null.
 *
 * NULL means "this heartbeat carried no telemetry" — an older bridge, or a
 * payload we could not make sense of. The caller then leaves every telemetry
 * column ALONE rather than writing nulls over them: a single odd heartbeat is
 * not evidence that a previously-reported radio has stopped existing, and
 * blanking `last_ble_ok` on one bad parse would silently clear a live
 * adapter_down alert and re-raise it on the next good heartbeat.
 *
 * The patch carries ONLY the keys this payload actually spoke to, for the same
 * reason at finer grain. If `adapters` is absent the two adapter columns are
 * omitted (keep what the bridge last said); if `adapters` is PRESENT but lists
 * no `ble`, `last_ble_ok` is included as null (the bridge is now saying it has
 * no such radio, which must clear a stale `false` rather than pin it forever).
 *
 * Never throws — see the module header.
 *
 * @param {unknown} body parsed heartbeat JSON
 * @returns {{ last_telemetry: object, last_pending_samples?: number,
 *             last_ant_ok?: boolean|null, last_ble_ok?: boolean|null }|null}
 */
export function parseBridgeTelemetry(body) {
  try {
    if (!isPlainObject(body)) return null

    // Nested wins when present; the shipping bridge sends flat. See header.
    const src = isPlainObject(body.telemetry) ? body.telemetry : body

    const adapters = isPlainObject(src.adapters) ? sanitiseAdapters(src.adapters) : null
    const pending = clampInt(src.pending_samples)
    const uptime = clampInt(src.uptime_s)

    // Nothing recognisable — an old bridge, or an empty keepalive. Not an
    // error, and explicitly not a reason to touch the stored telemetry.
    if (!adapters && pending === null && uptime === null) return null

    const telemetry = {}
    if (pending !== null) telemetry.pending_samples = pending
    if (uptime !== null) telemetry.uptime_s = uptime
    if (adapters) telemetry.adapters = adapters

    const patch = { last_telemetry: telemetry }
    if (pending !== null) patch.last_pending_samples = pending
    if (adapters) {
      patch.last_ant_ok = adapterHealth(adapters, 'ant')
      patch.last_ble_ok = adapterHealth(adapters, 'ble')
    }
    return patch
  } catch {
    // Defensive belt-and-braces: a getter that throws, a Proxy, a payload with
    // a poisoned prototype. A heartbeat is never worth failing.
    return null
  }
}
