// PACK-FRESHNESS.1 — data-quality check for Glofox pack credits.
//
// trial_credits_remaining on num_classes contacts gates the churn
// radar's Active base + the pack-running-low signal. This module's
// pure check answers one question: "has the nightly Glofox sync been
// keeping that data fresh?" — used by /api/cron/glofox-data-quality.

// num_classes contacts are re-synced every night by the glofox-
// attendance-refresh cron. If the most recent sync across the whole
// pack base is older than this, the pack-credit data is drifting —
// the nightly sync has most likely broken. 2 days leaves a full
// night of margin for one missed run before flagging.
export const PACK_CREDIT_MAX_AGE_DAYS = 2

/**
 * Is the Glofox pack-credit data stale?
 *
 * @param {string|null} latestSyncIso  the most recent glofox_synced_at
 *   across num_classes contacts, or null if none have ever synced
 * @param {number} [nowMs]
 * @returns {boolean}  true when the data is stale (or absent entirely)
 */
export function isPackCreditDataStale(latestSyncIso, nowMs = Date.now()) {
  if (!latestSyncIso) return true
  const t = new Date(latestSyncIso).getTime()
  if (!Number.isFinite(t)) return true
  return (nowMs - t) > PACK_CREDIT_MAX_AGE_DAYS * 86_400_000
}
