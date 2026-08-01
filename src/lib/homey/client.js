// HOMEYD.2 — Homey config (tri-state) + thin never-throw HTTP calls for the
// direct-control reconcile cron (see
// docs/superpowers/specs/2026-08-01-homey-direct-control-design.md).
//
// Config is tri-state, not boolean, because "unset" and "broken" need to
// behave differently:
//   - DORMANT (all three of HOMEY_API_URL / HOMEY_API_KEY /
//     HOMEY_LOCATION_ID absent or blank) — the feature hasn't been turned on
//     yet for this deploy. getHomeyConfig() returns null; the cron stamps
//     its heartbeat and exits `{ skipped: true }` quietly. This must NEVER
//     page — every Vercel deploy runs this cron before an operator has set
//     the env vars.
//   - MISCONFIGURED (some but not all set, or a value fails validation) —
//     someone started configuring this and got it wrong (half-pasted env,
//     the Homey *web-app* URL instead of the remote API origin, a typo'd
//     location UUID). getHomeyConfig() returns `{ error }`; the cron logs it
//     loudly via logWarn on every tick instead of silently no-op-ing
//     forever, because a silent dormant-looking failure here is exactly the
//     bug that would go unnoticed until someone asks "why hasn't the AC
//     turned off in three days".
//   - CONFIGURED (all three set and valid) — getHomeyConfig() returns
//     `{ url, apiKey, locationId }` ready to use.
//
// homeyGetDevices/homeySetOnoff are deliberately thin I/O and NOT unit
// tested (house pattern — see class-climate-runner.js and friends): they
// never throw, always resolve to `{ ok, statusCode, body }` (or
// `{ ok: false, statusCode: 0, networkError: true }` on a network/timeout
// failure), and are exported separately from the orchestration in
// reconcile.js (HOMEYD.3) so tests can inject fakes for them instead of
// hitting the network.
//
// The API key must never appear in a log line or a thrown error — every
// error path below names the env var, never its value.

import { uuidLike } from '@/lib/schemas'

const isBlank = (v) => v === undefined || v === null || String(v).trim() === ''

// Pure + exported for tests. Returns:
//   null   — fully unset (dormant) OR fully valid (nothing to report)
//   string — half-configured or invalid (the cron logs this loudly)
export function homeyConfigError(env) {
  const raw = {
    HOMEY_API_URL: env.HOMEY_API_URL,
    HOMEY_API_KEY: env.HOMEY_API_KEY,
    HOMEY_LOCATION_ID: env.HOMEY_LOCATION_ID,
  }
  const missing = Object.keys(raw).filter((k) => isBlank(raw[k]))

  if (missing.length === 3) return null // nothing set at all — dormant, not an error
  if (missing.length > 0) {
    return `Homey is half-configured — missing ${missing.join(', ')} (set all three env vars, or none)`
  }

  let u
  try {
    u = new URL(raw.HOMEY_API_URL)
  } catch {
    return `HOMEY_API_URL is not a valid URL: ${raw.HOMEY_API_URL}`
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `HOMEY_API_URL must be http(s): ${raw.HOMEY_API_URL}`
  }
  if (u.pathname !== '/' || u.search || u.hash) {
    return `HOMEY_API_URL must be a bare origin (no path/query) — the classic mis-paste is the Homey web-app URL instead of the remote API origin (https://<cloudid>.connect.athom.com): ${raw.HOMEY_API_URL}`
  }

  if (!uuidLike.safeParse(raw.HOMEY_LOCATION_ID).success) {
    return `HOMEY_LOCATION_ID is not a valid UUID: ${raw.HOMEY_LOCATION_ID}`
  }

  return null
}

// → `{ url, apiKey, locationId }` | `{ error }` | `null` (fully unset).
export function getHomeyConfig(env = process.env) {
  const err = homeyConfigError(env)
  if (err) return { error: err }

  const allUnset = isBlank(env.HOMEY_API_URL) && isBlank(env.HOMEY_API_KEY) && isBlank(env.HOMEY_LOCATION_ID)
  if (allUnset) return null

  return {
    url: new URL(env.HOMEY_API_URL).origin,
    apiKey: env.HOMEY_API_KEY.trim(),
    locationId: env.HOMEY_LOCATION_ID,
  }
}

async function homeyJson(cfg, method, path, body) {
  try {
    const res = await fetch(cfg.url + path, {
      method,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    let parsed = null
    const text = await res.text().catch(() => '')
    if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = null }
    }
    return { ok: res.ok, statusCode: res.status, body: parsed }
  } catch {
    // Network error, timeout, DNS failure, etc — never throw out of a
    // reconcile tick over a Homey that's rebooting or a flaky Tailscale hop.
    return { ok: false, statusCode: 0, networkError: true }
  }
}

export async function homeyGetDevices(cfg) {
  return homeyJson(cfg, 'GET', '/api/manager/devices/device')
}

export async function homeySetOnoff(cfg, sidecarDeviceId, on) {
  const homeyId = sidecarDeviceId.startsWith('homey:') ? sidecarDeviceId.slice(6) : sidecarDeviceId
  return homeyJson(cfg, 'PUT', `/api/manager/devices/device/${encodeURIComponent(homeyId)}/capability/onoff`, { value: on })
}
