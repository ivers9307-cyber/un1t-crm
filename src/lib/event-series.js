// event-series — HOSTSERIES.1: a group of event dates sharing one public page
// (event_series, mig 817; race_events.series_id).
//
// Ownership: a series belongs to its host (host_id) or, with host_id NULL, to
// staff at its studio. A host route takes a series id from the request body,
// so it asks hostOwnsSeries before any write: another host's series id must
// never attach an event to that host's page (the review that caught it:
// IDOR, unvalidated foreign key from the body).

import { logError } from './log'

/**
 * May `hostId` attach an event to `seriesId`? A failed read is load_failed,
 * never "yes".
 * @returns {Promise<{ ok: true } | { ok: false, error: 'invalid_series' | 'load_failed' }>}
 */
export async function hostOwnsSeries(db, { seriesId, hostId }) {
  if (!seriesId) return { ok: true }
  const { data, error } = await db.from('event_series').select('id, host_id').eq('id', seriesId).maybeSingle()
  if (error) {
    logError('event-series', 'series read failed', { err: error, seriesId })
    return { ok: false, error: 'load_failed' }
  }
  if (!data || data.host_id !== hostId) return { ok: false, error: 'invalid_series' }
  return { ok: true }
}
