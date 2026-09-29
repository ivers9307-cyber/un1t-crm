// ACDEVLOC.1 — the pieces the per-location AC device routes share:
//   /api/locations/[id]/ac-devices             GET list, POST add
//   /api/locations/[id]/ac-devices/discover    POST vendor discovery
//   /api/locations/[id]/ac-devices/[deviceId]  PATCH edit / enable / disable
//
// The insert and patch rules moved here from the retired
// /api/studio-management/ac/devices POST and /devices/[id] PATCH, which the
// settings tab used to call: those acted on the caller's ACTIVE studio (POST)
// and refused a disabled unit (PATCH, so Re-enable never worked).

import { overlayConnections } from '@/lib/connection-registry'

export const AC_PROVIDERS = Object.freeze(['sensibo', 'thinq'])

/**
 * ACALLOWLISTGATE.1 — is AC set up at this studio? Credentials for at least
 * one vendor, by the rule the control path applies before switching a unit
 * (ac-devices.js resolveCredentials): Sensibo needs the API key; LG ThinQ
 * needs the PAT and the client id. Pass the location row AFTER the registry
 * overlay (overlayConnections / overlayConnectionsMany with 'sensibo','thinq').
 * Pinned to the control path by ac-credentials-parity.test.js.
 * SERVER ONLY: the argument carries credentials; only the boolean may leave.
 */
export function acCredentialsConfigured(location) {
  if (!location) return false
  const sensibo = !!location.sensibo_api_key
  const thinq = !!location.thinq_pat && !!location.thinq_client_id
  return sensibo || thinq
}

// Whitelist of editable columns. provider / provider_device_id / location_id
// are never editable: they are the unit's identity.
const EDITABLE_KEYS = Object.freeze([
  'label', 'device_group',
  'default_mode', 'default_temp_c', 'default_fan',
  'session_minutes',
  'external_auto_off_minutes', // STUDIO-AC-EXTERNAL-RULE.1
  'enabled',
])

/**
 * @param {object} body  the validated PATCH body
 * @returns {{ patch: object } | { error: string }}
 */
export function normaliseDevicePatch(body) {
  const src = body && typeof body === 'object' ? body : {}
  const patch = {}
  for (const key of EDITABLE_KEYS) if (key in src) patch[key] = src[key]
  if (Object.keys(patch).length === 0) return { error: 'No editable fields supplied.' }
  if ('label' in patch) {
    const label = String(patch.label ?? '').trim()
    if (!label) return { error: 'label cannot be empty.' }
    patch.label = label
  }
  // A blank group means "no group" (rendered under 'Other'), never ''.
  if ('device_group' in patch) patch.device_group = String(patch.device_group ?? '').trim() || null
  if ('default_temp_c' in patch) patch.default_temp_c = Number(patch.default_temp_c)
  if ('session_minutes' in patch) patch.session_minutes = Number(patch.session_minutes)
  // '' / null / undefined disables the external-start rule; otherwise a
  // positive whole number of minutes.
  if ('external_auto_off_minutes' in patch) {
    const raw = patch.external_auto_off_minutes
    if (raw === null || raw === '' || raw === undefined) {
      patch.external_auto_off_minutes = null
    } else {
      const n = Number(raw)
      patch.external_auto_off_minutes = Number.isFinite(n) && n > 0 ? Math.round(n) : null
    }
  }
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') return { error: 'enabled must be true or false.' }
  return { patch }
}

/**
 * @param {string} locationId  the PATH location
 * @param {object} body        the validated POST body
 * @returns {{ insert: object } | { error: string }}
 */
export function buildDeviceInsert(locationId, body) {
  const src = body && typeof body === 'object' ? body : {}
  const provider = String(src.provider || '').toLowerCase()
  const providerDeviceId = String(src.provider_device_id || '').trim()
  const label = String(src.label || '').trim()
  if (!AC_PROVIDERS.includes(provider)) return { error: 'provider must be "sensibo" or "thinq".' }
  if (!providerDeviceId) return { error: 'provider_device_id is required.' }
  if (!label) return { error: 'label is required.' }
  return {
    insert: {
      location_id: locationId,
      label,
      provider,
      provider_device_id: providerDeviceId,
      // Only when given; otherwise the table defaults (cool / 22 / auto / 30).
      ...(src.default_mode ? { default_mode: src.default_mode } : {}),
      ...(src.default_temp_c ? { default_temp_c: Number(src.default_temp_c) } : {}),
      ...(src.default_fan ? { default_fan: src.default_fan } : {}),
      ...(src.session_minutes ? { session_minutes: Number(src.session_minutes) } : {}),
      // STUDIO-AC-GROUPS.1 — the mig 211 backfill defaults.
      device_group: src.device_group
        ? String(src.device_group).trim() || null
        : (provider === 'sensibo' ? 'Gym Floor' : 'Bathrooms'),
    },
  }
}

/**
 * The AC vendor credentials stored on ONE location (legacy columns with the
 * INTEG-A2 registry overlay). Server-only: the values must never be returned
 * to a client or logged.
 *
 * @returns {Promise<{ creds: { sensiboApiKey, thinqPat, thinqClientId, thinqCountryCode } }
 *   | { error: object } | { notFound: true }>}
 */
export async function readAcCredentials(db, locationId) {
  const { data, error } = await db
    .from('locations')
    .select('id, sensibo_api_key, thinq_pat, thinq_client_id, thinq_country_code')
    .eq('id', locationId)
    .maybeSingle()
  if (error) return { error }
  if (!data) return { notFound: true }
  const loc = await overlayConnections(db, data, ['sensibo', 'thinq'])
  return {
    creds: {
      sensiboApiKey: loc?.sensibo_api_key || null,
      thinqPat: loc?.thinq_pat || null,
      thinqClientId: loc?.thinq_client_id || null,
      thinqCountryCode: loc?.thinq_country_code || null,
    },
  }
}

/**
 * Scrub credentials out of a message before it is returned or logged. A
 * vendor error can quote what it was sent.
 */
export function redactSecrets(message, secrets = []) {
  let out = String(message ?? '')
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('••••')
  }
  return out
}

/** A Sensibo pod as the settings tab needs it: no vendor `raw`. */
export const publicPod = (p) => ({ id: p.id, room_name: p.room_name ?? null, product_model: p.product_model ?? null })

/** An LG ThinQ unit as the settings tab needs it: no vendor `raw`. */
export const publicThinqDevice = (d) => ({ device_id: d.device_id, alias: d.alias ?? null, model: d.model ?? null })
