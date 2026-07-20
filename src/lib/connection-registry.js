// INTEG-A2 — connections-registry dual-read accessor.
//
// channel_connections (migs 230 + 411) is becoming the single
// per-location registry for provider connections. Mig 419 backfilled
// it from today's legacy storage; this module is the ONE seam through
// which read paths resolve a provider's config during the migration:
//
//   registry row (active, per location+platform)  → wins when present
//   legacy location fields                        → fallback otherwise
//
// Legacy ⇄ registry mapping (must stay in lockstep with mig 419):
//
//   glofox         settings.glofox.branch_id      ⇄ external_account_id
//                  settings.glofox.api_key        ⇄ access_token
//                  settings.glofox.webhook_secret ⇄ app_secret
//                  everything else                ⇄ config
//   unifi          settings.unifi.api_token       ⇄ access_token
//                  everything else                ⇄ config
//   sensibo        sensibo_api_key                ⇄ access_token
//                  sensibo_pod_id                 ⇄ config.pod_id
//   thinq          thinq_pat                      ⇄ access_token
//                  thinq_client_id                ⇄ config.client_id
//                  thinq_country_code             ⇄ config.country_code
//   twilio_sender  twilio_alpha_sender_id         ⇄ config.sender_id
//   bca            bca_config                     ⇄ config
//
// Design notes:
//   - Reads are FAIL-OPEN: any error talking to the registry falls
//     back to the legacy fields, so a registry outage can never break
//     a provider that legacy config still serves. (Write paths still
//     write legacy during this phase, so legacy stays complete.)
//   - `status` is NOT consulted on the read path — legacy had no
//     status, so an 'error'/'action_needed' row is still used exactly
//     like its legacy equivalent would be. Status is for the hub UI +
//     the A3 health sweep.
//   - WhatsApp / Instagram / Messenger / Xero / ad accounts are OUT of
//     scope here — they keep their existing dedicated storage.
//
// Service-role only: channel_connections denies authenticated/anon
// writes and the read policy is staff-per-location, so pass the
// createServerClient() db. Never call from browser code.

export const DUAL_READ_PLATFORMS = Object.freeze([
  'glofox', 'unifi', 'sensibo', 'thinq', 'twilio_sender', 'bca',
])

const ROW_COLUMNS =
  'id, location_id, platform, status, is_active, label, display_name, ' +
  'external_account_id, access_token, app_secret, config, ' +
  'token_expires_at, last_error, last_ok_at'

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function omit(obj, keys) {
  const out = { ...obj }
  for (const k of keys) delete out[k]
  return out
}

function stripNulls(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Pure: per-platform legacy ⇄ registry converters
// ─────────────────────────────────────────────────────────────
//
// Each provider descriptor:
//   legacySelect          columns getConnection() fetches on fallback
//   rowFromLegacy(loc)    → { external_account_id?, access_token?,
//                             app_secret?, config } or null when the
//                             location has no legacy config (mirrors
//                             the mig 419 WHERE gates)
//   applyRow(loc, row)    → new location-shaped object with the
//                             legacy fields replaced by the registry
//                             row's values (the dual-read overlay)

const PROVIDERS = {
  glofox: {
    legacySelect: 'id, settings',
    rowFromLegacy(location) {
      const g = location?.settings?.glofox
      if (!isPlainObject(g) || Object.keys(g).length === 0) return null
      return {
        external_account_id: g.branch_id || null,
        access_token: g.api_key || null,
        app_secret: g.webhook_secret || null,
        config: omit(g, ['branch_id', 'api_key', 'webhook_secret']),
      }
    },
    applyRow(location, row) {
      return {
        ...location,
        settings: {
          ...(location.settings || {}),
          glofox: {
            ...(isPlainObject(row.config) ? row.config : {}),
            branch_id: row.external_account_id ?? null,
            api_key: row.access_token ?? null,
            webhook_secret: row.app_secret ?? null,
          },
        },
      }
    },
  },

  unifi: {
    legacySelect: 'id, settings',
    rowFromLegacy(location) {
      const u = location?.settings?.unifi
      if (!isPlainObject(u) || Object.keys(u).length === 0) return null
      return {
        access_token: u.api_token || null,
        config: omit(u, ['api_token']),
      }
    },
    applyRow(location, row) {
      return {
        ...location,
        settings: {
          ...(location.settings || {}),
          unifi: {
            ...(isPlainObject(row.config) ? row.config : {}),
            api_token: row.access_token ?? null,
          },
        },
      }
    },
  },

  sensibo: {
    legacySelect: 'id, sensibo_api_key, sensibo_pod_id',
    rowFromLegacy(location) {
      if (!location?.sensibo_api_key) return null
      return {
        access_token: location.sensibo_api_key,
        config: stripNulls({ pod_id: location.sensibo_pod_id }),
      }
    },
    applyRow(location, row) {
      return {
        ...location,
        sensibo_api_key: row.access_token ?? null,
        sensibo_pod_id: row.config?.pod_id ?? null,
      }
    },
  },

  thinq: {
    legacySelect: 'id, thinq_pat, thinq_client_id, thinq_country_code',
    rowFromLegacy(location) {
      if (!location?.thinq_pat && !location?.thinq_client_id) return null
      return {
        access_token: location.thinq_pat || null,
        config: stripNulls({
          client_id: location.thinq_client_id,
          country_code: location.thinq_country_code,
        }),
      }
    },
    applyRow(location, row) {
      return {
        ...location,
        thinq_pat: row.access_token ?? null,
        thinq_client_id: row.config?.client_id ?? null,
        thinq_country_code: row.config?.country_code ?? null,
      }
    },
  },

  twilio_sender: {
    legacySelect: 'id, twilio_alpha_sender_id',
    rowFromLegacy(location) {
      if (!location?.twilio_alpha_sender_id) return null
      return { config: { sender_id: location.twilio_alpha_sender_id } }
    },
    applyRow(location, row) {
      return {
        ...location,
        twilio_alpha_sender_id: row.config?.sender_id ?? null,
      }
    },
  },

  bca: {
    legacySelect: 'id, bca_config',
    rowFromLegacy(location) {
      const c = location?.bca_config
      if (!isPlainObject(c) || Object.keys(c).length === 0) return null
      return { config: c }
    },
    applyRow(location, row) {
      return {
        ...location,
        bca_config: isPlainObject(row.config) ? row.config : null,
      }
    },
  },
}

/**
 * Registry-row fields a legacy-configured location maps to, or null
 * when the location has no legacy config for the platform. Pure —
 * mirrors mig 419's mapping exactly; used by the refresh endpoint to
 * re-sync a registry row after a legacy save.
 */
export function registryRowFromLegacy(platform, location) {
  const p = PROVIDERS[platform]
  if (!p) return null
  return p.rowFromLegacy(location)
}

/**
 * Overlay one registry row's values onto a location-shaped object
 * (returns a new object; unknown platforms are a no-op). Pure.
 */
export function applyConnectionRow(location, row) {
  const p = row && PROVIDERS[row.platform]
  if (!p || !location) return location
  return p.applyRow(location, row)
}

/**
 * Overlay many registry rows onto a location-shaped object. Pure.
 */
export function applyConnectionOverlay(location, rows) {
  let out = location
  for (const row of rows || []) out = applyConnectionRow(out, row)
  return out
}

/**
 * Normalise a channel_connections row for callers that want the
 * generic shape rather than legacy field names. Pure.
 */
export function normalizeConnectionRow(row) {
  return {
    source: 'registry',
    platform: row.platform,
    locationId: row.location_id,
    status: row.status || 'connected',
    isActive: row.is_active !== false,
    label: row.label ?? null,
    displayName: row.display_name ?? null,
    externalAccountId: row.external_account_id ?? null,
    accessToken: row.access_token ?? null,
    appSecret: row.app_secret ?? null,
    config: isPlainObject(row.config) ? row.config : {},
    tokenExpiresAt: row.token_expires_at ?? null,
    lastError: row.last_error ?? null,
    lastOkAt: row.last_ok_at ?? null,
  }
}

/**
 * Normalise a location's LEGACY fields into the same shape. Pure.
 * status is derived: 'connected' when legacy config exists, else
 * 'not_connected'.
 */
export function normalizeLegacyConnection(platform, location) {
  const raw = registryRowFromLegacy(platform, location)
  const configured = !!raw
  const fields = raw || {}
  return {
    source: 'legacy',
    platform,
    locationId: location?.id ?? null,
    status: configured ? 'connected' : 'not_connected',
    isActive: configured,
    label: null,
    displayName: null,
    externalAccountId: fields.external_account_id ?? null,
    accessToken: fields.access_token ?? null,
    appSecret: fields.app_secret ?? null,
    config: isPlainObject(fields.config) ? fields.config : {},
    tokenExpiresAt: null,
    lastError: null,
    lastOkAt: null,
  }
}

// ─────────────────────────────────────────────────────────────
// Async: registry reads (fail-open to legacy)
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the active registry rows for one location. Returns [] on any
 * error (fail-open — callers then keep the legacy values).
 */
export async function fetchActiveConnections(db, locationId, platforms = DUAL_READ_PLATFORMS) {
  if (!db || !locationId) return []
  try {
    const { data, error } = await db
      .from('channel_connections')
      .select(ROW_COLUMNS)
      .eq('location_id', locationId)
      .eq('is_active', true)
      .in('platform', platforms)
    if (error || !Array.isArray(data)) return []
    return data
  } catch {
    return []
  }
}

/**
 * THE dual-read accessor: normalized connection for one
 * (location, platform) — active registry row first, legacy location
 * fields otherwise.
 */
export async function getConnection(db, locationId, platform) {
  const provider = PROVIDERS[platform]
  if (!provider) throw new Error(`getConnection: unknown platform '${platform}'`)
  const rows = await fetchActiveConnections(db, locationId, [platform])
  if (rows[0]) return normalizeConnectionRow(rows[0])
  let location = null
  try {
    const { data } = await db
      .from('locations')
      .select(provider.legacySelect)
      .eq('id', locationId)
      .maybeSingle()
    location = data || null
  } catch {
    location = null
  }
  return normalizeLegacyConnection(platform, { id: locationId, ...(location || {}) })
}

/**
 * Dual-read overlay for an already-fetched location-shaped object:
 * returns a copy whose LEGACY field names carry the registry values
 * for every platform that has an active row (so existing pure
 * helpers — getLocationUnifiConfig, getBcaConfig, getLocationSenderId,
 * resolveCredentials — read registry values without changing shape).
 * Platforms without a registry row keep the legacy values untouched;
 * any registry error returns the input unchanged (fail-open).
 */
export async function overlayConnections(db, location, platforms = DUAL_READ_PLATFORMS) {
  if (!db || !location?.id) return location
  const rows = await fetchActiveConnections(db, location.id, platforms)
  if (!rows.length) return location
  return applyConnectionOverlay(location, rows)
}

/**
 * Batched overlayConnections for a list of location rows (one
 * registry query for all of them). Fail-open like the single form.
 */
export async function overlayConnectionsMany(db, locations, platforms = DUAL_READ_PLATFORMS) {
  const list = Array.isArray(locations) ? locations : []
  const ids = [...new Set(list.map((l) => l?.id).filter(Boolean))]
  if (!db || !ids.length) return list
  let rows = []
  try {
    const { data, error } = await db
      .from('channel_connections')
      .select(ROW_COLUMNS)
      .in('location_id', ids)
      .eq('is_active', true)
      .in('platform', platforms)
    rows = !error && Array.isArray(data) ? data : []
  } catch {
    rows = []
  }
  if (!rows.length) return list
  const byLocation = new Map()
  for (const row of rows) {
    const bucket = byLocation.get(row.location_id) || []
    bucket.push(row)
    byLocation.set(row.location_id, bucket)
  }
  return list.map((l) => {
    const bucket = l?.id ? byLocation.get(l.id) : null
    return bucket ? applyConnectionOverlay(l, bucket) : l
  })
}

// ─────────────────────────────────────────────────────────────
// Provider conveniences (exact legacy shapes)
// ─────────────────────────────────────────────────────────────

/**
 * The settings.glofox-shaped config object for a location —
 * registry-first, legacy fallback. Always an object (may be empty),
 * matching the `data?.settings?.glofox || {}` reads it replaces.
 */
export async function getGlofoxConfig(db, locationId) {
  const conn = await getConnection(db, locationId, 'glofox')
  // Unconfigured legacy location → {} (matches `settings?.glofox || {}`).
  if (conn.source === 'legacy' && conn.status === 'not_connected') return {}
  return {
    ...conn.config,
    branch_id: conn.externalAccountId,
    api_key: conn.accessToken,
    webhook_secret: conn.appSecret,
  }
}

/**
 * Registry-side reverse lookup for the Glofox webhook receiver:
 * active glofox connection by branch id. Returns the settings.glofox
 * shape + locationId, or null (caller falls back to the legacy
 * containment query). Fail-open on error.
 */
export async function findGlofoxConfigByBranchId(db, branchId) {
  if (!db || !branchId) return null
  try {
    const { data, error } = await db
      .from('channel_connections')
      .select(ROW_COLUMNS)
      .eq('platform', 'glofox')
      .eq('external_account_id', branchId)
      .eq('is_active', true)
      .limit(1)
    if (error || !data?.[0]) return null
    const conn = normalizeConnectionRow(data[0])
    return {
      locationId: conn.locationId,
      cfg: {
        ...conn.config,
        branch_id: conn.externalAccountId,
        api_key: conn.accessToken,
        webhook_secret: conn.appSecret,
      },
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Dual-write helper (legacy remains the written source of truth;
// this re-syncs the registry row so registry-first reads never go
// stale after a legacy save)
// ─────────────────────────────────────────────────────────────

/**
 * Upsert (or deactivate) the active registry row for one platform
 * from a location row's CURRENT legacy fields. Service client only.
 *
 *   legacy configured  → update the active row's mapped fields (or
 *                        insert one), status reset to 'connected'
 *   legacy cleared     → deactivate any active row (reads then fall
 *                        back to legacy = unconfigured, matching
 *                        today's behaviour)
 *
 * Select-then-write rather than .upsert(): the one-active guarantee
 * is a PARTIAL unique index (mig 230) which PostgREST upsert can't
 * target. The tiny race window is acceptable for settings saves.
 */
export async function syncConnectionFromLegacy(db, locationId, platform, location) {
  const fields = registryRowFromLegacy(platform, location)
  const { data: existing } = await db
    .from('channel_connections')
    .select('id')
    .eq('location_id', locationId)
    .eq('platform', platform)
    .eq('is_active', true)
    .maybeSingle()

  if (!fields) {
    if (existing) {
      await db
        .from('channel_connections')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { action: existing ? 'deactivated' : 'noop' }
  }

  const patch = {
    external_account_id: fields.external_account_id ?? null,
    access_token: fields.access_token ?? null,
    app_secret: fields.app_secret ?? null,
    config: fields.config ?? {},
    status: 'connected',
    last_error: null,
    updated_at: new Date().toISOString(),
  }
  if (existing) {
    const { error } = await db
      .from('channel_connections')
      .update(patch)
      .eq('id', existing.id)
    if (error) throw new Error(`registry sync (${platform}): ${error.message}`)
    return { action: 'updated' }
  }
  const { error } = await db
    .from('channel_connections')
    .insert({ location_id: locationId, platform, is_active: true, ...patch })
  if (error) throw new Error(`registry sync (${platform}): ${error.message}`)
  return { action: 'inserted' }
}
