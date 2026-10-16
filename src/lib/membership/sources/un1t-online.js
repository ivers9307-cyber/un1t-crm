// UN1TSYNC.5 — un1t.online (Hatch Street's gym platform) as a membership
// source. Configured = an ACTIVE channel_connections row (platform
// 'un1t_online') holding both the API token and the studio it was issued for.
// A failed registry read is `readError`, never "not configured"
// (REGISTRYREAD.1). Every capability is false in this plan: the sync reads
// members, subscriptions, payments and bookings into the un1t_* tables, but
// nothing Glofox-shaped (credits, invoices, a class schedule) lights up for
// the location with empty data.
import { readConnection } from '@/lib/connection-registry'

export const UN1T_ONLINE_UNREADABLE = 'UN1T_ONLINE_CONNECTION_UNREADABLE'

export const un1tOnlineSource = Object.freeze({
  key: 'un1t_online',
  label: 'un1t.online',
  capabilities: Object.freeze({ memberships: false, bookings: false, credits: false, invoices: false, schedule: false }),
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
