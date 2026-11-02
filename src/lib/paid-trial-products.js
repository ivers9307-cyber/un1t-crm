// HATCH39 — which un1t.online products are a studio's PAID trial (Hatch
// Street's €39 14-day "The UN1T Trial").
// Spec: docs/superpowers/specs/2026-11-01-hatch-paid-trial-board-design.md
//
// un1t.online records the purchase as a `pack` transaction, so every read that
// asks "is this a Class Pack" (the pipeline snapshot, free-trial eligibility,
// the dashboard's pack-holder count, the Churn Radar) filed the 69 buyers as
// pack customers. A paid trial is a trial membership, never a pack holder, on
// every read (Richard, 1 Nov 2026) — and this is the ONE place the set comes
// from: the studio setting `locations.settings.pipelines.paid_trial.un1t_product_ids`
// (seeded by mig 803) ∪ the product the live /trial page sells for the studio
// (its paid_trial block's un1t_product_id, src/lib/trial-studios.js). A second
// paid trial product plugs in through either.
//
// A failed read THROWS: a reader given no set behaves as before (buyers read as
// packs), so "could not read" must never quietly become "no paid trials". The
// un1t read adapter catches it and fails the pass, as it does any input.

import { loadTrialStudios } from '@/lib/trial-studios'

const clean = (v) => (typeof v === 'string' ? v.trim() : '')

/** The ids in a location's settings jsonb (strings, trimmed, non-empty). Pure. */
export function paidTrialIdsFromSettings(settings) {
  const list = settings?.pipelines?.paid_trial?.un1t_product_ids
  if (!Array.isArray(list)) return []
  return list.map(clean).filter(Boolean)
}

/**
 * @param {object} db  service-role client
 * @param {string|null} locationId
 * @returns {Promise<Set<string>>}
 * @throws on a failed settings read, or when the /trial page's entry for this
 *   studio is unreadable
 */
export async function paidTrialProductIdsFor(db, locationId) {
  if (!db || !locationId) return new Set()

  const { data, error } = await db
    .from('locations')
    .select('settings')
    .eq('id', locationId)
    .maybeSingle()                         // primary key; 0 rows = no settings
  if (error) throw new Error(`paid-trial products: settings read failed: ${error.message || error}`)
  const ids = new Set(paidTrialIdsFromSettings(data?.settings))

  const studios = await loadTrialStudios(db)
  // Fail closed: a list that is not a list is "could not read", never "no paid trials".
  if (!Array.isArray(studios)) throw new Error('paid-trial products: trial page list unreadable')
  for (const entry of studios) {
    if (!entry || entry.locationId !== locationId) continue
    if (entry.unreadable) throw new Error('paid-trial products: trial page unreadable for this studio')
    const fromBlock = clean(entry.block?.un1t_product_id)
    if (fromBlock) ids.add(fromBlock)
  }
  return ids
}
