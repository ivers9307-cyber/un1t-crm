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
})

export function defaultPipelineStages() {
  return [...FUNNEL_STAGE_SLUGS, ...OFF_FUNNEL_STAGE_SLUGS].map((slug) => ({
    slug,
    ...STAGE_DETAILS[slug],
    archived: false,
    is_dormant: OFF_FUNNEL_STAGE_SLUGS.includes(slug),
  }))
}

/**
 * Seed the per-location defaults a new location needs to function.
 * Idempotent: safe to re-run for a partially provisioned location
 * (upsert ignores duplicates on the mig 150 uq (location_id, slug)).
 *
 * @param {object} db - service-role client (createServerClient())
 * @param {{ id: string }} location - the freshly created locations row
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
}
