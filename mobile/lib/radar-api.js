// MOBILE-RADAR — data helper for the read-only radar glance.
//
// Unlike most mobile data (which goes direct to Supabase, scoped by
// RLS), the radars are heavy server-side scans — a few thousand rows
// scored per call — so this goes through the /api wrapper to the
// dedicated /api/mobile/radar endpoint. Read-only: triage actions
// (win-back, quarantine, cleanup) stay on the web radar.

import { api } from './api'

/**
 * Fetch the radar glance summary for a location.
 *
 * Resolves to the standard { success, data?, error? } envelope. On
 * success, data is { churn: {...}|null, lead: {...}|null } — a section
 * is null when the caller lacks that mobile permission. data may also
 * carry churnError / leadError strings for a partial failure.
 *
 * @param {object} [opts]
 * @param {string} [opts.locationId]  override the active location
 */
export function fetchRadarGlance({ locationId } = {}) {
  return api('/api/mobile/radar', { locationId })
}
