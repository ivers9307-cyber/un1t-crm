// UniFi Protect — minimal client for face-library access.
//
// Per-location config lives on locations.settings.unifi_protect
// (sibling of locations.settings.unifi for Access — they're
// independent because the two systems can be hosted on different
// controllers, with separate API tokens).
//
// We only ever need three operations:
//
//   1. List known faces                → GET /proxy/protect/api/files/faces
//   2. Get one face's metadata          → GET /proxy/protect/api/files/faces/{id}
//   3. (future) Trigger a re-enrolment  → POST .../faces/{id}/re-enroll
//
// All other Protect surfaces (cameras, smart detection rules,
// alarm manager) live entirely in UniFi — managers configure those
// once per studio in the UniFi console. The CRM's only job is to
// map face IDs to staff profiles so the inbound webhook can resolve
// "this alarm fired for face X" to "X is John's face → stamp John's
// shift".
//
// API base: https://<host>/proxy/protect/api
//   - Bearer token auth via X-API-KEY header (Protect's "Local Users
//     → API Key" flow).
//   - Self-signed cert by default; allow_self_signed in settings
//     opts in to insecure mode (same pattern as unifi-access.js).
//
// Failure semantics: every public function is best-effort. A
// network failure / permission refusal returns { ok: false, error }
// rather than throwing — the StaffForm picker degrades to manual
// face_id text entry, which is the canonical fallback (operator can
// always copy/paste the face id straight from the UniFi UI).

import { Agent, fetch as undiciFetch } from 'undici'

const DEFAULT_TIMEOUT_MS = 10_000

let insecureDispatcher = null
function getInsecureDispatcher() {
  if (!insecureDispatcher) {
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  }
  return insecureDispatcher
}

/**
 * Pull the per-location Protect config out of locations.settings.
 * Returns { configured, host, apiKey, allowSelfSigned }.
 *
 * configured = true only when host AND apiKey are set. The face-
 * library API requires both; the picker switches between dropdown
 * (configured) and free-text (not configured).
 */
export function getLocationProtectConfig(location) {
  const u = location?.settings?.unifi_protect || {}
  // Some operators reach for the Access settings.unifi key first —
  // accept either path as the host source so the on-site setup
  // doesn't require both keys to be set. Auth still requires the
  // Protect-specific api_key (Access uses api_token).
  const host = (u.host || location?.settings?.unifi?.host || '').trim().replace(/\/+$/, '')
  const apiKey = (u.api_key || '').trim()
  return {
    configured: Boolean(host && apiKey),
    host,
    apiKey,
    allowSelfSigned: u.allow_self_signed === true || location?.settings?.unifi?.allow_self_signed === true,
  }
}

/**
 * Wrap fetch with the Protect auth header + self-signed-cert
 * handling + timeout. Returns the raw Response — caller decides
 * how to parse.
 */
async function protectFetch(cfg, path, opts = {}) {
  if (!cfg?.configured) throw new ProtectError('Protect not configured', { status: 0 })
  const url = path.startsWith('http')
    ? path
    : `${cfg.host}${path.startsWith('/') ? '' : '/'}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    return await undiciFetch(url, {
      ...opts,
      headers: {
        'X-API-KEY': cfg.apiKey,
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
      signal: controller.signal,
      dispatcher: cfg.allowSelfSigned ? getInsecureDispatcher() : undefined,
    })
  } finally {
    clearTimeout(timeout)
  }
}

class ProtectError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'ProtectError'
    this.status = status
    this.code = code
  }
}

/**
 * List the known faces enrolled in Protect's face library at this
 * location. Returns { ok: true, faces: [{ id, name, enrolledAt }] }
 * on success, { ok: false, error } on any failure.
 *
 * The shape of Protect's response varies across firmware — we
 * normalise to a stable { id, name, enrolledAt } per face. Anything
 * we couldn't parse becomes { id, name: id, enrolledAt: null } so
 * the picker still surfaces it (operator can rename later).
 */
export async function listKnownFaces(cfg) {
  if (!cfg?.configured) {
    return { ok: false, error: 'unifi_protect not configured for this location' }
  }
  let r
  try {
    r = await protectFetch(cfg, '/proxy/protect/api/files/faces')
  } catch (e) {
    return { ok: false, error: e?.message || 'network error' }
  }
  if (!r.ok) {
    return { ok: false, error: `Protect returned HTTP ${r.status}`, status: r.status }
  }
  let body
  try { body = await r.json() } catch { body = null }
  // Body is typically { items: [...] } OR a bare array. Normalise.
  const items = Array.isArray(body?.items) ? body.items
              : Array.isArray(body)         ? body
              : []
  const faces = items.map(normaliseFace).filter(Boolean)
  return { ok: true, faces }
}

function normaliseFace(item) {
  if (!item || typeof item !== 'object') return null
  const id = item.id || item._id || item.faceId || item.uuid
  if (!id) return null
  // Display name: try the obvious fields, fall back to id for the
  // picker label (operator can always rename in Protect later).
  const name = item.name || item.label || item.display_name || String(id)
  // Enrolment time: Protect commonly reports as `created` (ms epoch)
  // or `createdAt` (ISO). Tolerate both; null when neither.
  let enrolledAt = null
  if (typeof item.created === 'number') {
    enrolledAt = new Date(item.created).toISOString()
  } else if (typeof item.createdAt === 'string') {
    enrolledAt = new Date(item.createdAt).toISOString()
  } else if (typeof item.enrolledAt === 'string') {
    enrolledAt = new Date(item.enrolledAt).toISOString()
  }
  return { id: String(id), name: String(name), enrolledAt }
}

/**
 * Resolve a single face id → profile_locations row at a location.
 * Used by the receiver (P2.5) to map an inbound alarm to the right
 * staff profile. Returns null when no mapping exists (event becomes
 * an "unknown_user" audit row).
 */
export async function findProfileByFaceId(db, locationId, faceId) {
  if (!db || !locationId || !faceId) return null
  const { data } = await db
    .from('profile_locations')
    .select('profile_id, role')
    .eq('location_id', locationId)
    .eq('protect_face_id', faceId)
    .limit(1)
  return data?.[0] || null
}
