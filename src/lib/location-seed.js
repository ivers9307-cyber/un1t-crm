// SAAS4-W0.1 — per-location seed defaults.
//
// A fresh location MUST carry the full FUNNEL.1 pipeline_stages set or
// the classifier breaks the moment it returns a slug with no row for
// that location (the mig 150 incident class). Migs 350/356/391 seeded
// existing locations via CROSS JOIN at migration time only — nothing
// covered locations created afterwards, and LocationForm.jsx seeded a
// stale pre-FUNNEL taxonomy. This module is now the single seed path:
// the stage list mirrors the live prod rows (names/colors/orders from
// migs 350/356/391), and location-seed.test.js pins the slug set to
// FUNNEL_STAGE_SLUGS + OFF_FUNNEL_STAGE_SLUGS so seed and classifier
// can only drift together.

import { FUNNEL_STAGE_SLUGS, OFF_FUNNEL_STAGE_SLUGS } from '../../shared/pipeline-classifier.js'
import { BUNDLE_KEYS } from '../../shared/permission-bundles.js'
import { DEFAULT_NOTIFICATION_CONFIG } from './notification-config.js'

// (slug → row detail) in canonical order. Orders 301–310 match prod
// (the 300-block sorts after the archived PIPELINE5 200-block).
const STAGE_DETAILS = Object.freeze({
  new_lead: { name: 'New Leads', display_order: 301, color: '#3B82F6' },
  first_class: { name: '1st Class', display_order: 302, color: '#10B981' },
  second_class: { name: '2nd Class', display_order: 303, color: '#14B8A6' },
  trial_done: { name: 'Trial Done', display_order: 304, color: '#F59E0B' },
  converted: { name: 'Converted', display_order: 305, color: '#059669' },
  member: { name: 'Member', display_order: 306, color: '#64748B' },
  pack_member: { name: 'Class Pack', display_order: 307, color: '#0891B2' },
  classpass: { name: 'ClassPass', display_order: 308, color: '#A855F7' },
  dormant: { name: 'Dormant', display_order: 309, color: '#6B7280' },
  cold_lead: { name: 'Cold', display_order: 310, color: '#52525B' },
  // GYMPASS.2 (mig 430) — Gympass/Wellhub platform users, off-funnel.
  // Appended at 311 (unique order); orange to distinguish from ClassPass.
  gympass: { name: 'Gympass', display_order: 311, color: '#F97316' },
})

export function defaultPipelineStages() {
  return [...FUNNEL_STAGE_SLUGS, ...OFF_FUNNEL_STAGE_SLUGS].map((slug) => ({
    slug,
    ...STAGE_DETAILS[slug],
    archived: false,
    is_dormant: OFF_FUNNEL_STAGE_SLUGS.includes(slug),
  }))
}

// ============================================================
// BUNDLES.5 Task 3 — new-location bundle defaults.
//
// PROMINENT BACK-COMPAT NOTE: this ONLY runs for a brand-new location
// via seedLocationDefaults below (called once, right after the INSERT
// in src/app/api/locations/route.js). It is NEVER re-run against an
// EXISTING location — every location created before this shipped keeps
// its literal `{}` features blob untouched, which (per the polarity
// documented throughout shared/permission-bundles.js) still means
// "every bundle on". This function only changes what a location looks
// like the MOMENT it is born.
//
// The starter set (messaging, sales, members ON — every other bundle +
// module_cars OFF) is a PROPOSAL, not a fixed policy: an operator can
// flip any of the 8 bundle toggles on Location Features immediately
// after creation. The point is killing the "born fully enabled"
// provisioning pain (every one of ~50 fine-grained keys defaulting on
// for a location that may only ever need three hubs) while still
// giving a brand-new tenant a working CRM (leads in, contacts tracked,
// members visible) out of the box rather than a blank slate that needs
// 8 manual flips before it does anything.
// ============================================================

export const STARTER_BUNDLES = Object.freeze(['bundle_messaging', 'bundle_sales', 'bundle_members'])

/**
 * Pure: the bundle portion of a fresh location's `features` blob.
 * Every BUNDLE_KEYS entry NOT in STARTER_BUNDLES is set explicitly
 * `false`; STARTER_BUNDLES entries are left OUT of the result (missing
 * key = on, same default-on polarity as everywhere else in the bundle
 * layer — see shared/permission-bundles.js). Merges onto (does not
 * replace) whatever the location row already carries, so re-running
 * this against an already-provisioned location never clobbers a
 * feature key an operator set by hand.
 *
 * @param {object|null|undefined} existingFeatures
 * @returns {object}
 */
export function seedBundleFeatures(existingFeatures) {
  const features = { ...(existingFeatures || {}) }
  for (const bundleKey of BUNDLE_KEYS) {
    if (STARTER_BUNDLES.includes(bundleKey)) continue
    if (!(bundleKey in features)) features[bundleKey] = false
  }
  return features
}

// PIPELINES.6b — a board is now a row in `pipelines`, and pipeline_stages /
// deals both carry a pipeline_id that a later migration sets NOT NULL. Every
// stage a fresh location gets must hang off a pipeline from the moment it's
// created, or that migration lands and the next new-location stage insert
// fails outright — a break that only surfaces the next time someone adds a
// location, exactly when nobody is watching for it.
const ACQUISITION_PIPELINE = Object.freeze({
  key: 'acquisition',
  name: 'Acquisition',
  module: 'acquisition',
  mode: 'derived',
  is_primary: true,
  display_order: 0,
  enabled: true,
})

/**
 * Resolve the id of a location's acquisition pipeline, creating it if it
 * doesn't exist yet. Re-runnable: a (location_id, key) conflict (mig 594's
 * `pipelines_location_key_unique`) means a prior run already seeded it, so
 * the existing row's id is read back rather than treating the re-run as a
 * failure (same idempotent shape as the pipeline_stages upsert below).
 *
 * @param {object} db - service-role client
 * @param {string} locationId
 * @returns {Promise<string>} the pipeline id
 */
async function resolveAcquisitionPipelineId(db, locationId) {
  const { data: inserted, error: insertError } = await db
    .from('pipelines')
    .insert({ ...ACQUISITION_PIPELINE, location_id: locationId })
    .select('id')
    .single()
  if (!insertError) return inserted.id

  // 23505 = unique_violation on (location_id, key) — someone already seeded
  // this location's pipeline (wizard retry, resumed provisioning). Any other
  // error is a real failure and must not proceed to an unparented stage insert.
  if (insertError.code !== '23505') {
    throw new Error(`seedLocationDefaults: pipelines insert failed: ${insertError.message}`)
  }

  const { data: existing, error: selectError } = await db
    .from('pipelines')
    .select('id')
    .eq('location_id', locationId)
    .eq('key', ACQUISITION_PIPELINE.key)
    .maybeSingle()
  if (selectError) throw new Error(`seedLocationDefaults: pipelines lookup failed: ${selectError.message}`)
  if (!existing?.id) {
    // A stage insert that silently proceeds without a pipeline is the exact
    // break this function exists to prevent — throw rather than seed orphans.
    throw new Error(`seedLocationDefaults: could not resolve an acquisition pipeline id for location ${locationId}`)
  }
  return existing.id
}

/**
 * Seed the per-location defaults a new location needs to function.
 * Idempotent: safe to re-run for a partially provisioned location
 * (the pipelines insert falls back to reading back the existing row on a
 * conflict; the pipeline_stages upsert ignores duplicates on the mig 150 uq
 * (location_id, slug); the bundle-features write only ever ADDS missing
 * keys, never overwrites an existing one — see seedBundleFeatures above;
 * the W1.W1 settings seed ignores an existing company_settings row and
 * writes notification_config only while it is NULL).
 *
 * @param {object} db - service-role client (createServerClient())
 * @param {{ id: string, name?: string, is_host_anchor?: boolean, features?: object }} location
 *   - the freshly created locations row (POST /api/locations passes the
 *   insert's `.select().single()` result, so name + is_host_anchor are on it)
 */
export async function seedLocationDefaults(db, location) {
  if (!location?.id) throw new Error('seedLocationDefaults: location with id required')

  const pipelineId = await resolveAcquisitionPipelineId(db, location.id)

  const rows = defaultPipelineStages().map((stage) => ({
    ...stage,
    location_id: location.id,
    pipeline_id: pipelineId,
  }))

  const { error } = await db
    .from('pipeline_stages')
    .upsert(rows, { onConflict: 'location_id,slug', ignoreDuplicates: true })
  if (error) throw new Error(`seedLocationDefaults: pipeline_stages upsert failed: ${error.message}`)

  const nextFeatures = seedBundleFeatures(location.features)
  const { error: featErr } = await db
    .from('locations')
    .update({ features: nextFeatures })
    .eq('id', location.id)
  if (featErr) throw new Error(`seedLocationDefaults: locations.features bundle seed failed: ${featErr.message}`)

  // W1.W1 — settings rows a tenant location is born with (SaaS Wave 1,
  // decision 6). Both idempotent: the company_settings upsert ignores an
  // existing row (an operator's branding is never overwritten), and
  // notification_config is written only while NULL (NULL already means
  // "code defaults"; the explicit copy makes the settings page show real
  // values instead of an empty form). company_name = the LOCATION's name,
  // so the brand chain (company_settings → org_settings → locations.name)
  // resolves to this studio's own name from day one; logo/favicon stay
  // null and fall through to the org's. Quiet hours are NOT named: mig
  // 514's NOT NULL DEFAULT columns (enabled, 21 → 8) apply on the insert.
  // Host-anchor locations (host-events.js) are a technical shell with no
  // brand or staff of their own and are never seeded with settings.
  if (!location.is_host_anchor) {
    const { error: csErr } = await db
      .from('company_settings')
      .upsert(
        {
          location_id: location.id,
          company_name: (location.name || '').trim() || null,
          logo_url: null,
          favicon_url: null,
        },
        { onConflict: 'location_id', ignoreDuplicates: true },
      )
    if (csErr) throw new Error(`seedLocationDefaults: company_settings seed failed: ${csErr.message}`)

    // Read fresh rather than trusting the passed row: a re-run (wizard
    // retry) passes whatever the caller held, which may predate an
    // operator's edit. The seed exists to fill a gap, never to reset.
    const { data: cur, error: curErr } = await db
      .from('locations')
      .select('notification_config')
      .eq('id', location.id)
      .maybeSingle()
    if (curErr) throw new Error(`seedLocationDefaults: notification_config read failed: ${curErr.message}`)
    if (!cur?.notification_config) {
      const { error: ncErr } = await db
        .from('locations')
        .update({ notification_config: DEFAULT_NOTIFICATION_CONFIG })
        .eq('id', location.id)
      if (ncErr) throw new Error(`seedLocationDefaults: notification_config seed failed: ${ncErr.message}`)
    }
  }
}
