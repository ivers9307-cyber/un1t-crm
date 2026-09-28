// SECFIX.3a — a `locations` row as it may cross to a browser or a phone.
//
// Six stored integration credentials live on the row: two columns and four
// keys inside `settings`. Anything handed to a client component, or returned
// as JSON, must carry their PRESENCE (many screens and one server page ask
// "is Glofox configured?") but never their VALUE. Each non-empty one is
// replaced by LOCATION_SECRET_MASK:
//   * the key stays, so truthiness checks (automations glofoxConnected,
//     StaffForm.isUnifiConfigured, LocationIntegrations statuses) still hold;
//   * the mask starts with '••', which isFreshSecret()
//     (src/lib/integration-secret-merge.js) rejects, so a mask echoed back to
//     PUT /api/locations/[id]/integrations/[provider] keeps the stored value.
//
// Server code that needs a credential reads the row fresh by id with the
// service role (glofoxCredentialsForLocation, getUnifiConfig, the AC and
// registry helpers). It must never take one off a redacted row.
//
// Structure-preserving on purpose: no key is added or removed, and a row with
// nothing to redact is returned as the same object.

export const LOCATION_SECRET_MASK = '••••••'

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
])

// getCurrentUser()'s location select: the identity plus `settings`, which the
// automations pages read for Glofox presence (glofoxConnected). `settings` is
// passed through redactLocationSecrets after the read; the credential COLUMNS
// are never loaded. A new column is off the user object until added here.
export const USER_LOCATION_COLUMNS = [...CLIENT_LOCATION_COLUMNS, 'settings'].join(', ')

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const present = (v) => (typeof v === 'string' ? v.trim() !== '' : v != null && v !== false)

/**
 * @param {object|null|undefined} row  a `locations` row (any column subset)
 * @returns the row with every present credential masked (same object if none)
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
  return out
}

/** profile_locations rows with an embedded `locations` row → same rows, location redacted. */
export function redactLinkedLocations(links) {
  if (!Array.isArray(links)) return links
  return links.map((l) => (isPlainObject(l) && isPlainObject(l.locations)
    ? { ...l, locations: redactLocationSecrets(l.locations) }
    : l))
}

/** A staff row read with `profile_locations(*, locations(*))` → safe to return as JSON. */
export function redactProfileLocations(profile) {
  if (!isPlainObject(profile) || !Array.isArray(profile.profile_locations)) return profile
  return { ...profile, profile_locations: redactLinkedLocations(profile.profile_locations) }
}
