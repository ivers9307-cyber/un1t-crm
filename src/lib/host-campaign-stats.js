// HOST-METRICS.1 — shared lookup for host_campaign_stats() (mig 590), a SQL
// function returning one row per campaign { campaign_id, queued, sent,
// delivered, opened, clicked, bounced, complained, unsubscribed, failed }.
// Bigints arrive via PostgREST as strings, so every count is Number()'d
// here once instead of at each call site. A failed rpc must never fail the
// page it backs (the host emails list, the recipients report) — the error
// is returned, not thrown, and callers fall back to ZERO_STATS.

import { logWarn } from '@/lib/log'

export const ZERO_STATS = Object.freeze({
  queued: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  failed: 0,
})

const KEYS = Object.keys(ZERO_STATS)

/**
 * @returns {Promise<{ byCampaign: Map<string, typeof ZERO_STATS>, error: object|null }>}
 */
export async function loadHostCampaignStats(db, hostId) {
  const { data, error } = await db.rpc('host_campaign_stats', { p_host_id: hostId })
  const byCampaign = new Map()
  if (error) {
    logWarn('host-emails', 'stats rpc failed', { hostId, err: error })
    return { byCampaign, error }
  }
  for (const row of data || []) {
    const stats = {}
    for (const key of KEYS) stats[key] = Number(row?.[key] ?? 0)
    byCampaign.set(row.campaign_id, stats)
  }
  return { byCampaign, error: null }
}
