// SECFIX.3a — a `locations` row as it may cross to a browser or a phone.
//
// Six stored integration credentials live on the row: two columns and four
// keys inside `settings`. Anything handed to a client component, or returned
// as JSON, must carry their PRESENCE (several screens ask "is Glofox
// configured?") but never their VALUE. Each non-empty one is replaced by
// LOCATION_SECRET_MASK:
//   * the key stays, so truthiness checks (LocationIntegrations statuses)
//     still hold;
//   * the mask starts with '••', which isFreshSecret()
//     (src/lib/integration-secret-merge.js) rejects, so a mask echoed back to
//     PUT /api/locations/[id]/integrations/[provider] keeps the stored value.
//
// The six are named explicitly below, and ON TOP of them every key that mig
// 647's audit rule calls a secret (src/lib/secret-keys.js, the one shared
// copy) is masked, at any depth of the row, `settings` included, up to the
// rule's depth cap of 12. So a credential added to `settings` later (a new
// integration slice, a key inside an array) is hidden without anyone
// remembering this file. That also masks the `bca_config` COLUMN whole where
// a row carries it (/settings/locations/[id] reads '*'): no
// consumer of a redacted row reads it (the BCA routes and the integrations
// tab read it fresh, not off these rows), and the user object never loads it
// (USER_LOCATION_COLUMNS). Booleans and blank values are left as they are.
//
// Server code that needs a credential reads the row fresh by id with the
// service role (glofoxCredentialsForLocation, getUnifiConfig, the AC and
// registry helpers). It must never take one off a redacted row.
//
// Structure-preserving on purpose: no key is added or removed, and a row with
// nothing to redact is returned as the same object.

import { SECRET_MASK, maskSecretKeysDeep } from './secret-keys.js'

export const LOCATION_SECRET_MASK = SECRET_MASK

export const LOCATION_CREDENTIAL_COLUMNS = Object.freeze(['sensibo_api_key', 'thinq_pat'])

export const LOCATION_SETTINGS_CREDENTIALS = Object.freeze({
  glofox: Object.freeze(['api_key', 'api_token', 'webhook_secret']),
  unifi: Object.freeze(['api_token']),
})

// What any browser may see of a location: its public identity. The same list
// as mig 648's SELECT grant to `authenticated` (SECFIX.3c; the 3c guard
// asserts they match). Every field the user object's consumers read is here.
export const CLIENT_LOCATION_COLUMNS = Object.freeze([
  'id', 'name', 'slug', 'address', 'phone', 'email', 'timezone', 'active',
  'created_at', 'updated_at', 'country', 'features', 'organization_id', 'is_host_anchor',
  // W1.M1 (mig 717): 'none' | 'glofox' | 'un1t'. On the user object on
  // purpose: pages gate their membership surfaces on it.
  'membership_source',
])

// getCurrentUser()'s location select: exactly the client identity. It used
// to add `settings` (masked) because the automations pages read Glofox
// presence off the user object; they read it themselves now
// (readGlofoxAutomationStatus, PROFILESPREAD.1), so every page stops
// carrying the location's config, including the customer agent's test phone
// numbers. A new column is off the user object until added to
// CLIENT_LOCATION_COLUMNS (which is also mig 648's grant list).
export const USER_LOCATION_COLUMNS = CLIENT_LOCATION_COLUMNS.join(', ')

const USER_LOCATION_KEYS = new Set(CLIENT_LOCATION_COLUMNS)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const present = (v) => (typeof v === 'string' ? v.trim() !== '' : v != null && v !== false)

/**
 * A locations row as the user object carries it: only CLIENT_LOCATION_COLUMNS.
 * The select already names them; this is the second lock, so a widened select
 * (or a raw row from anywhere) can never put settings or a credential on the
 * object. Returns the same object when there is nothing to drop.
 */
export function toUserLocation(row) {
  if (!isPlainObject(row)) return row
  const keys = Object.keys(row)
  if (keys.every((k) => USER_LOCATION_KEYS.has(k))) return row
  const out = {}
  for (const k of keys) if (USER_LOCATION_KEYS.has(k)) out[k] = row[k]
  return out
}

/** profile_locations rows with an embedded `locations` row → the same, location picked. */
export function toUserLinkedLocations(links) {
  if (!Array.isArray(links)) return links
  return links.map((l) => (isPlainObject(l) && isPlainObject(l.locations) ? { ...l, locations: toUserLocation(l.locations) } : l))
}

/**
 * @param {object|null|undefined} row  a `locations` row (any column subset)
 * @returns the row with every present credential masked (same object if none):
 *          the six named ones, then every secret-named key at any depth
 */
export function redactLocationSecrets(row) {
  if (!isPlainObject(row)) return row
  let out = row
  for (const col of LOCATION_CREDENTIAL_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, col) && present(row[col])) {
      if (out === row) out = { ...row }
      out[col] = LOCATION_SECRET_MASK
    }
  }
  const settings = row.settings
  if (isPlainObject(settings)) {
    let nextSettings = settings
    for (const [slice, keys] of Object.entries(LOCATION_SETTINGS_CREDENTIALS)) {
      const s = settings[slice]
      if (!isPlainObject(s)) continue
      let nextSlice = s
      for (const k of keys) {
        if (present(s[k])) {
          if (nextSlice === s) nextSlice = { ...s }
          nextSlice[k] = LOCATION_SECRET_MASK
        }
      }
      if (nextSlice !== s) {
        if (nextSettings === settings) nextSettings = { ...settings }
        nextSettings[slice] = nextSlice
      }
    }
    if (nextSettings !== settings) {
      if (out === row) out = { ...row }
      out.settings = nextSettings
    }
  }
  return maskSecretKeysDeep(out, { mask: LOCATION_SECRET_MASK })
}

/**
 * A staff row whose profile_locations embed carries every location column → safe to return as JSON.
 * (Its per-link half was exported as redactLinkedLocations until PROFILESPREAD.1a
 * left getCurrentUser, its only other caller, with no settings to mask.)
 */
export function redactProfileLocations(profile) {
  if (!isPlainObject(profile) || !Array.isArray(profile.profile_locations)) return profile
  return {
    ...profile,
    profile_locations: profile.profile_locations.map((l) => (isPlainObject(l) && isPlainObject(l.locations)
      ? { ...l, locations: redactLocationSecrets(l.locations) }
      : l)),
  }
}
