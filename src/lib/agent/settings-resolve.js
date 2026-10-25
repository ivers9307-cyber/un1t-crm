import { logError, logWarn } from '@/lib/log'
import { DEFAULTS, STUDIO_ONLY_KEYS, INHERITABLE_OBJECT_KEYS, OrgSettingsSchema } from './settings-contract'

// MIAORG.1 — the ONE place Mia's effective settings for a studio are decided:
//
//   DEFAULTS  <-  org_settings.customer_agent  <-  locations.settings.customer_agent
//
// * The org layer never supplies a STUDIO_ONLY_KEYS key (enabled, test_mode,
//   test_phones, booking_mode, consultation_event_type_id, cancellation_form,
//   booking_url / booking_cta_label, membership_signup_url / membership_cta_label,
//   monthly_points_target):
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
// * Task 4 (T4-A) — `quiet_hours.off` is studio-only in effect. At the STUDIO
//   layer `off: true` means "no quiet hours here, whatever the organisation
//   says": the effective quiet_hours is start/end null (so
//   core.isWithinQuietHours is never true) and its source is 'studio'. Any
//   other `off` value, and `off` at the org layer, is ignored.

// The quiet-hours opt-out read off one layer (see the header).
function withoutOff(q) {
  if (!isPlainObject(q) || !('off' in q)) return q
  const { off: _off, ...rest } = q
  return rest
}

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
    let orgValue = STUDIO_ONLY_KEYS.has(key) ? undefined : orgBlob[key]
    let studioValue = studioBlob[key]

    if (key === 'quiet_hours') {
      if (isPlainObject(studioValue) && studioValue.off === true) {
        settings.quiet_hours = { start: null, end: null, tz: null, off: true }
        sources.quiet_hours = 'studio'
        continue
      }
      orgValue = withoutOff(orgValue)
      studioValue = withoutOff(studioValue)
    }

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
 *     location: { id: string, name: string, timezone: string|null, organization_id: string|null, membership_source: string|null, settings: object|null } }
 *   | { ok: false, reason: 'read_failed'|'not_found' }>}
 */
export async function resolveAgentSettings(db, locationId, { orgCache } = {}) {
  if (!locationId) return { ok: false, reason: 'not_found' }

  let location
  try {
    const { data, error } = await db.from('locations')
      // MIAORG.1 Task 5 — membership_source rides on the same row (mig 717:
      // NOT NULL DEFAULT 'none'), so Mia's capability for the turn comes from
      // the read that already gates the turn, never a second read that could
      // fail on its own and flip a Glofox studio to no-booking.
      .select('id, name, timezone, organization_id, membership_source, settings')
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
  // organization_id is pinned to a present key (null when the row has none) so
  // the row variant below never mistakes it for a caller's narrow select.
  return resolveAgentSettingsForLocation(db, { ...location, id: location.id ?? locationId, organization_id: location.organization_id ?? null }, { orgCache })
}

// The org layer for one organisation, or null (no row, NULL column, a failed
// read, or a layer OrgSettingsSchema refuses; the last two are logged, and the
// studio then resolves without it).
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
    const layer = isPlainObject(data?.customer_agent) ? data.customer_agent : null
    if (!layer) return null
    // MIAORG.1 final review — defence in depth behind mig 729's write fence: a
    // layer the org editor itself would refuse (written by hand, or before the
    // fence) never reaches a studio's turn. A bad org row must never break or
    // weaken a studio, so an invalid layer is logged and treated as no layer
    // (the studio resolves on its own blob over DEFAULTS). Validation only:
    // the RAW layer is used when it passes, never the parsed copy, whose
    // schema defaults (followups.enabled false, daily_cap 50, ...) would fill
    // fields the organisation never set.
    const check = OrgSettingsSchema.safeParse(layer)
    if (!check.success) {
      logError('agent-settings', 'org settings layer is invalid; resolving without the org layer', {
        locationId, organizationId,
        issues: check.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
      return null
    }
    return layer
  } catch (err) {
    logError('agent-settings', 'org settings read threw; resolving without the org layer', { locationId, organizationId, err })
    return null
  }
}

/**
 * MIAORG.1 Task 2 — resolve from a `locations` row the caller already holds
 * (the sweeps and runners that loop every studio). The row must carry
 * `id`, `organization_id` and `settings` (and `name` / `timezone` if the
 * caller wants them back on `location`). `organization_id: null` means the
 * studio has no organisation (no org layer). A row whose select left
 * `organization_id` OFF (the key absent) is never silently resolved without
 * the org layer: it is re-read by id (resolveAgentSettings) and logged, so the
 * caller's select gets fixed.
 *
 * `orgCache` (a Map, one per run): each organisation's layer is read once and
 * shared by its studios. A failed org read is cached as "no org layer" for the
 * rest of that run, logged once; the next run reads again.
 *
 * Same return shape as resolveAgentSettings; a missing row is not_found.
 */
export async function resolveAgentSettingsForLocation(db, location, { orgCache } = {}) {
  if (!location || !location.id) return { ok: false, reason: 'not_found' }
  if (location.organization_id === undefined) {
    logWarn('agent-settings', 'location row has no organization_id key; re-reading it by id (select organization_id)', { locationId: location.id })
    return resolveAgentSettings(db, location.id, { orgCache })
  }

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
      // MIAORG.1 Task 5 — null when the caller's row did not select it.
      membership_source: location.membership_source ?? null,
      settings: location.settings ?? null,
    },
  }
}
