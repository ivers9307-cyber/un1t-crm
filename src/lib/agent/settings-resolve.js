import { logError } from '@/lib/log'
import { DEFAULTS, STUDIO_ONLY_KEYS, INHERITABLE_OBJECT_KEYS } from './settings-contract'

// MIAORG.1 — the ONE place Mia's effective settings for a studio are decided:
//
//   DEFAULTS  <-  org_settings.customer_agent  <-  locations.settings.customer_agent
//
// * The org layer never supplies a STUDIO_ONLY_KEYS key (enabled, test_mode,
//   test_phones, booking_mode, consultation_event_type_id, cancellation_form,
//   booking_url / booking_cta_label, membership_signup_url / membership_cta_label):
//   an org-level `enabled: true` must never switch a studio on.
// * `null` / `undefined` at the studio means "not set here", so the org value
//   (then the default) shows through. A set value, including 0 / false / [],
//   wins.
// * INHERITABLE_OBJECT_KEYS (limits, followups, first_class_checkin,
//   inline_suggestion, quiet_hours) merge PER FIELD, org fields under studio
//   fields, and only when the value is a plain object; anything else is
//   ignored for that layer.
// * `sources[key]` says which layer a key came from: 'studio' | 'org' |
//   'default'. For an object key, 'studio' when the studio set ANY of its
//   fields, else 'org' when the org did, else 'default'.
// * With org_settings.customer_agent NULL everywhere every studio resolves
//   exactly to DEFAULTS <- its own blob, as before this layer existed.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isSet = (v) => v !== null && v !== undefined

// A layer's usable object fields: only the keys that are actually set.
function setFields(obj) {
  const out = {}
  if (!isPlainObject(obj)) return out
  for (const [k, v] of Object.entries(obj)) if (isSet(v)) out[k] = v
  return out
}

// Overlay one layer's fields onto `base`: a set field wins; a null/undefined
// field is carried only where nothing below holds a value for it.
function overlayFields(base, layer) {
  if (!isPlainObject(layer)) return
  for (const [f, v] of Object.entries(layer)) {
    if (isSet(v) || !isSet(base[f])) base[f] = v
  }
}

/**
 * Pure merge of the two stored blobs over DEFAULTS.
 * @param {{ org?: object|null, studio?: object|null }} layers
 * @returns {{ settings: object, sources: Record<string, 'studio'|'org'|'default'> }}
 */
export function mergeAgentSettings({ org = null, studio = null } = {}) {
  const orgBlob = isPlainObject(org) ? org : {}
  const studioBlob = isPlainObject(studio) ? studio : {}
  const settings = structuredClone(DEFAULTS)
  const sources = {}
  for (const k of Object.keys(DEFAULTS)) sources[k] = 'default'

  const keys = new Set([...Object.keys(DEFAULTS), ...Object.keys(orgBlob), ...Object.keys(studioBlob)])
  for (const key of keys) {
    const orgValue = STUDIO_ONLY_KEYS.has(key) ? undefined : orgBlob[key]
    const studioValue = studioBlob[key]

    if (INHERITABLE_OBJECT_KEYS.includes(key)) {
      const hasStudio = Object.keys(setFields(studioValue)).length > 0
      const hasOrg = Object.keys(setFields(orgValue)).length > 0
      if (!hasStudio && !hasOrg) continue
      // defaults < org < studio, per field (see overlayFields).
      const merged = isPlainObject(DEFAULTS[key]) ? structuredClone(DEFAULTS[key]) : {}
      overlayFields(merged, orgValue)
      overlayFields(merged, studioValue)
      settings[key] = merged
      sources[key] = hasStudio ? 'studio' : 'org'
      continue
    }

    if (isSet(studioValue)) {
      settings[key] = structuredClone(studioValue)
      sources[key] = 'studio'
    } else if (isSet(orgValue)) {
      settings[key] = structuredClone(orgValue)
      sources[key] = 'org'
    }
  }
  return { settings, sources }
}

/**
 * Resolve the effective Mia settings for one studio.
 *
 * A failed STUDIO read is { ok:false } (callers keep today's behaviour: skip /
 * 500). A failed ORG read is logged and the studio resolves without the org
 * layer: a reply in the studio's own settings beats no reply.
 *
 * @param {object} db  service-role supabase client
 * @param {string} locationId
 * @param {{ orgCache?: Map<string, Promise<object|null>> }} [opts]  MIAORG.1
 *   Task 2 — pass one Map per run when resolving many studios so each
 *   organisation's layer is read once per run (see resolveAgentSettingsForLocation).
 * @returns {Promise<
 *   { ok: true, settings: object, sources: object, studio: object|null, org: object|null,
 *     location: { id: string, name: string, timezone: string|null, organization_id: string|null, settings: object|null } }
 *   | { ok: false, reason: 'read_failed'|'not_found' }>}
 */
export async function resolveAgentSettings(db, locationId, { orgCache } = {}) {
  if (!locationId) return { ok: false, reason: 'not_found' }

  let location
  try {
    const { data, error } = await db.from('locations')
      .select('id, name, timezone, organization_id, settings')
      .eq('id', locationId)
      .maybeSingle()
    if (error) {
      logError('agent-settings', 'studio settings read failed', { locationId, err: error })
      return { ok: false, reason: 'read_failed' }
    }
    if (!data) return { ok: false, reason: 'not_found' }
    location = data
  } catch (err) {
    logError('agent-settings', 'studio settings read threw', { locationId, err })
    return { ok: false, reason: 'read_failed' }
  }

  // The row was read BY this id, so it is this location's even if a narrow
  // select (or a test fake) left `id` off it.
  return resolveAgentSettingsForLocation(db, { ...location, id: location.id ?? locationId }, { orgCache })
}

// The org layer for one organisation, or null (no row, NULL column, or a
// failed read, which is logged: the studio then resolves without it).
async function readOrgLayer(db, organizationId, locationId) {
  try {
    const { data, error } = await db.from('org_settings')
      .select('customer_agent')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) {
      logError('agent-settings', 'org settings read failed; resolving without the org layer', { locationId, organizationId, err: error })
      return null
    }
    return isPlainObject(data?.customer_agent) ? data.customer_agent : null
  } catch (err) {
    logError('agent-settings', 'org settings read threw; resolving without the org layer', { locationId, organizationId, err })
    return null
  }
}

/**
 * MIAORG.1 Task 2 — resolve from a `locations` row the caller already holds
 * (the sweeps and runners that loop every studio). The row must carry
 * `id`, `organization_id` and `settings` (and `name` / `timezone` if the
 * caller wants them back on `location`); a row read without
 * `organization_id` silently resolves without the org layer, so select it.
 *
 * `orgCache` (a Map, one per run): each organisation's layer is read once and
 * shared by its studios. A failed org read is cached as "no org layer" for the
 * rest of that run, logged once; the next run reads again.
 *
 * Same return shape as resolveAgentSettings; a missing row is not_found.
 */
export async function resolveAgentSettingsForLocation(db, location, { orgCache } = {}) {
  if (!location || !location.id) return { ok: false, reason: 'not_found' }

  const studioRaw = location.settings?.customer_agent
  const studio = isPlainObject(studioRaw) ? studioRaw : null

  let org = null
  const orgId = location.organization_id
  if (orgId) {
    let pending = orgCache?.get(orgId)
    if (!pending) {
      pending = readOrgLayer(db, orgId, location.id)
      orgCache?.set(orgId, pending)
    }
    org = await pending
  }

  const { settings, sources } = mergeAgentSettings({ org, studio })
  return {
    ok: true,
    settings,
    sources,
    studio,
    org,
    location: {
      id: location.id,
      name: location.name,
      timezone: location.timezone ?? null,
      organization_id: location.organization_id ?? null,
      settings: location.settings ?? null,
    },
  }
}
