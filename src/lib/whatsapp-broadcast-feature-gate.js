// C122 WABROADCASTKILL.1 — which studios the WhatsApp broadcast cron may send
// at. The rule is tier 1 of resolvePermission, the location gate that refuses
// even masters: isFeatureEnabledAtLocation(location, 'whatsapp') over
// `locations.features` (the per-key toggle AND the owning bundles,
// shared/permission-bundles.js). Nothing is re-derived here.
//
// The cron sends only at the ids this returns, so a studio that is missing
// from the read, or a broadcast with no studio, counts as off (fail closed).
// Pure.

import { isFeatureEnabledAtLocation } from '@shared/permissions'

/** Ids of the studios (`{ id, features }` rows) where WhatsApp is on. */
export function whatsappEnabledLocationIds(locations) {
  return (locations || [])
    .filter((l) => l?.id && isFeatureEnabledAtLocation(l, 'whatsapp'))
    .map((l) => l.id)
}

/**
 * PostgREST `.or()` filter for the rows the cron skips: no studio, or a studio
 * outside `enabledIds`. `null` when no studio is enabled (every row is
 * skipped, so no filter). Location ids are uuids, safe inside `in.(…)`.
 */
export function notEnabledLocationFilter(enabledIds) {
  if (!enabledIds?.length) return null
  return `location_id.is.null,location_id.not.in.(${enabledIds.join(',')})`
}
