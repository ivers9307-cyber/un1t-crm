// STAFFFORMSETTINGS.1 — the studios the staff editor (StaffForm, a client
// component, so everything here is serialised into the page) may know about.
//
// /settings/staff/new and /settings/staff/[id] used to read `locations`
// select('*') and pass the rows (credentials masked, SECFIX.3a) straight to
// StaffForm, so each studio's whole `settings` went into the page:
// customer_agent.test_phones (staff phone numbers) and every integration's
// config. StaffForm reads id, name, slug and features, plus ONE fact from
// settings: is UniFi configured here? That fact is computed here, on the
// server, by the SAME rule the save path uses (staff-write.js →
// getUnifiConfig: registry overlay, then getLocationUnifiConfig), so the
// form's "UniFi not configured" can never disagree with what a save does.
//
// SERVER ONLY. `settings` is read here and never returned.

import { CLIENT_LOCATION_COLUMNS, toUserLocation } from './location-secrets.js'
import { overlayConnectionsMany } from './connection-registry.js'
import { getLocationUnifiConfig } from './unifi-access.js'
import { logError, logWarn } from './log.js'

// The identity columns (mig 648's client grant list) plus `settings`, which
// only the unifi_configured computation below reads.
export const STAFF_FORM_LOCATION_SELECT = [...CLIENT_LOCATION_COLUMNS, 'settings'].join(', ')

/**
 * @param db service-role Supabase client
 * @returns {Promise<{ locations: object[], error: ({ code: string|null }|null) }>}
 *   each location = CLIENT_LOCATION_COLUMNS + `unifi_configured` (boolean).
 *   A failed read is logged and yields `locations: []` with `error` set: the
 *   page renders as it always did on a failed read (no studios), never an
 *   error page (plan C59 D3).
 */
export async function loadStaffFormLocations(db) {
  const { data, error } = await db
    .from('locations')
    .select(STAFF_FORM_LOCATION_SELECT)
    .eq('active', true)
    .eq('is_host_anchor', false)
    .order('name')
  if (error) {
    const code = error.code || null
    logError('staff-form-locations', 'locations read failed; the staff form shows no studios', { code })
    return { locations: [], error: { code } }
  }
  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) return { locations: [], error: null }

  // One batched registry read; fails open to the legacy slice (and logs), as
  // the save path's getUnifiConfig does.
  const overlaid = await overlayConnectionsMany(db, rows, ['unifi'])
  const locations = rows.map((row, i) => ({
    ...toUserLocation(row),
    unifi_configured: unifiConfigured(overlaid[i] ?? row),
  }))
  return { locations, error: null }
}

// getLocationUnifiConfig .trim()s each field, so a non-string one (a
// hand-edited settings blob, a registry config) throws. One malformed studio
// must not 500 both staff pages: it reads "not configured" (no save could
// use it either) and is logged by id and error code only, never the config.
function unifiConfigured(location) {
  try {
    return getLocationUnifiConfig(location).configured === true
  } catch (e) {
    logWarn('staff-form-locations', 'malformed UniFi config; shown as not configured', {
      locationId: location?.id ?? null,
      code: e?.code || e?.name || null,
    })
    return false
  }
}
