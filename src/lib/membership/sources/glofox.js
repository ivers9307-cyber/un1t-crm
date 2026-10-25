// W1.M1 — Glofox as a membership source. isConfigured rides the registry-
// first credentials read (channel_connections platform='glofox', then the
// legacy settings.glofox slice) and keeps the three-credential rule the
// runtime paths use (missingGlofoxCredentialsForLocation). A failed settings
// read is `readError`, never "not configured" (REGISTRYREAD.1).
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'

export const glofoxSource = Object.freeze({
  key: 'glofox',
  label: 'Glofox',
  capabilities: Object.freeze({ memberships: true, bookings: true, credits: true, invoices: true, schedule: true }),
  /**
   * @returns {Promise<{ configured: boolean, missing?: string[], readError?: string }>}
   */
  async isConfigured(db, locationId) {
    const creds = await glofoxCredentialsForLocation(db, locationId)
    if (creds.readError) return { configured: false, readError: creds.readError }
    const missing = missingGlofoxCredentialsForLocation(creds)
    return missing.length ? { configured: false, missing } : { configured: true }
  },
})
