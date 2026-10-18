// UN1TSYNC.5 — un1t.online (Hatch Street's gym platform) as a membership
// source. Configured = an ACTIVE channel_connections row (platform
// 'un1t_online') holding both the API token and the studio it was issued for.
// A failed registry read is `readError`, never "not configured"
// (REGISTRYREAD.1). The sync reads members, subscriptions, payments and
// bookings into the un1t_* tables. HATCHINV.1: `invoices` is the one capability
// on: a member's invoices, subscriptions and past-due rows are read from
// `un1t_invoices` through the reads' `pastDue` / `paymentsFor`. memberships,
// bookings, credits and schedule stay false: nothing else Glofox-shaped lights
// up for the location with empty data. Every reader of `invoices` is classified
// in tests/invoices-capability-readers.test.js.
import { readConnection } from '@/lib/connection-registry'

export const UN1T_ONLINE_UNREADABLE = 'UN1T_ONLINE_CONNECTION_UNREADABLE'

export const un1tOnlineSource = Object.freeze({
  key: 'un1t_online',
  label: 'un1t.online',
  capabilities: Object.freeze({ memberships: false, bookings: false, credits: false, invoices: true, schedule: false }),
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
