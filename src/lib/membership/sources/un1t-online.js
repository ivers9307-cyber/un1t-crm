// UN1TSYNC.5 — un1t.online (Hatch Street's gym platform) as a membership
// source. Configured = an ACTIVE channel_connections row (platform
// 'un1t_online') holding both the API token and the studio it was issued for.
// A failed registry read is `readError`, never "not configured"
// (REGISTRYREAD.1). The sync reads members, subscriptions, payments and
// bookings into the un1t_* tables. HATCHINV.1: `invoices` is on: a member's
// invoices, subscriptions and past-due rows are read from `un1t_invoices`
// through the reads' `pastDue` / `paymentsFor`. UN1TRADAR.4: `memberships` is
// on: every surface behind it reads the membership seam (spec B §8):
//   - /dashboard/churn-radar and /dashboard/lead-radar (incl. the digest and
//     dunning settings cards), /dashboard/engagement, the studio scorecard's
//     radar cells and the business Churn risk KPI;
//   - the churn-radar-snapshot and lead-radar-snapshot crons (Mon 06:00 / 06:30
//     UTC), the Monday digest to the studio's own recipient list, and the
//     morning briefing's Studio pulse strip;
//   - the radar read APIs, /api/mobile/radar and the today-feed churn row
//     answer un1t data instead of data:null; provides_memberships is true on
//     the phone.
// Nothing customer-facing starts: no sequence, trigger, push or Mia path reads
// the capability; radar outreach is staff-initiated (refused with no number
// switched on), payment reminders and the Glofox refresh are refused at a
// un1t.online studio. bookings, credits and schedule stay false. Every reader
// is classified in tests/memberships-capability-readers.test.js and
// tests/invoices-capability-readers.test.js.
import { readConnection } from '@/lib/connection-registry'

export const UN1T_ONLINE_UNREADABLE = 'UN1T_ONLINE_CONNECTION_UNREADABLE'

export const un1tOnlineSource = Object.freeze({
  key: 'un1t_online',
  label: 'un1t.online',
  capabilities: Object.freeze({ memberships: true, bookings: false, credits: false, invoices: true, schedule: false }),
  /**
   * @returns {Promise<{ configured: boolean, missing?: string[], readError?: string }>}
   */
  async isConfigured(db, locationId) {
    const { conn, error } = await readConnection(db, locationId, 'un1t_online')
    if (error || !conn) return { configured: false, readError: UN1T_ONLINE_UNREADABLE }
    const missing = []
    if (!conn.accessToken) missing.push('api_token')
    if (!conn.externalAccountId) missing.push('studio')
    return missing.length ? { configured: false, missing } : { configured: true }
  },
})
