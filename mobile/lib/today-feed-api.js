// MOBILE-TODAY-FEED — data helper for the "Needs attention" card on
// the Today dashboard.
//
// Goes through the /api wrapper (NOT direct Supabase) because the feed
// is a heavy server-side composition — approvals registry fan-out,
// radar scoring, a live Glofox call — and because the per-source
// permission gating lives server-side in fetchTodayFeed. The api()
// helper attaches auth + x-active-location + the impersonation header
// (never hand-roll a Bearer header — see the #382 lesson).

import { api } from './api'

/**
 * Fetch the viewer's triage rows for the active location.
 *
 * Resolves to the standard { success, data?, error? } envelope. On
 * success, data is { rows: [...] } — rows follow the
 * shared/today-feed.js shape ({ id, label, count, detail?, items?,
 * href }). Empty rows = all clear or no queue permissions; the card
 * renders nothing.
 *
 * @param {object} [opts]
 * @param {string} [opts.locationId]  override the active location
 */
export function fetchTodayFeedRows({ locationId } = {}) {
  return api('/api/mobile/today-feed', { locationId })
}
