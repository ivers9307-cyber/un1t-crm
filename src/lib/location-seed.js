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

/**
 * Seed the per-location defaults a new location needs to function.
 * Idempotent: safe to re-run for a partially provisioned location
 * (upsert ignores duplicates on the mig 150 uq (location_id, slug);
 * the bundle-features write only ever ADDS missing keys, never
 * overwrites an existing one — see seedBundleFeatures above).
 *
 * @param {object} db - service-role client (createServerClient())
 * @param {{ id: string, features?: object }} location - the freshly created locations row
 */
export async function seedLocationDefaults(db, location) {
  if (!location?.id) throw new Error('seedLocationDefaults: location with id required')

  const rows = defaultPipelineStages().map((stage) => ({
    ...stage,
    location_id: location.id,
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
}
