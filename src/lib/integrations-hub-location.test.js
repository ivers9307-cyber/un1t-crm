// INTEGONE.1 — the hub drawer's per-location context. The viewer flags are the
// five role expressions LocationIntegrations.jsx computed in the browser; the
// hosted tabs take them as props, so a drift here changes who can edit what.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/membership/source', () => ({
  membershipSourceState: vi.fn(async () => ({ source: 'none', state: 'none' })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { hubViewerFlags, loadHubLocationContext, HUB_XERO_CONNECTION_COLUMNS, HUB_BCA_SAMPLE_CAR_COLUMNS } from './integrations-hub-location'

const LOC = { id: 'loc-1', organization_id: 'org-1' }

describe('hubViewerFlags', () => {
  it('owner here: owner/master + WhatsApp owner + switch; numbers only for an org admin', () => {
    const user = { role: 'owner', profileRole: 'staff', rolesByLocation: { 'loc-1': 'owner' }, orgAdminOrgIds: [] }
    expect(hubViewerFlags(user, LOC)).toEqual({
      isMaster: false, isOwnerOrMaster: true, ownsWhatsAppHere: true, canSwitchWhatsApp: true, canManageNumbers: false,
    })
    expect(hubViewerFlags({ ...user, orgAdminOrgIds: ['org-1'] }, LOC).canManageNumbers).toBe(true)
  })

  it('a manager here may switch WhatsApp numbers but owns nothing', () => {
    const user = { role: 'owner', profileRole: 'staff', rolesByLocation: { 'loc-1': 'manager', 'loc-2': 'owner' }, orgAdminOrgIds: [] }
    expect(hubViewerFlags(user, LOC)).toEqual({
      isMaster: false, isOwnerOrMaster: false, ownsWhatsAppHere: false, canSwitchWhatsApp: true, canManageNumbers: false,
    })
  })

  it('a master gets everything (role master; the per-location bypass reads profileRole)', () => {
    const user = { role: 'master', profileRole: 'master', isMaster: true, rolesByLocation: {} }
    expect(hubViewerFlags(user, LOC)).toEqual({
      isMaster: true, isOwnerOrMaster: true, ownsWhatsAppHere: true, canSwitchWhatsApp: true, canManageNumbers: true,
    })
  })

  it('fails closed with no user or no location', () => {
    expect(hubViewerFlags(null, LOC)).toEqual({
      isMaster: false, isOwnerOrMaster: false, ownsWhatsAppHere: false, canSwitchWhatsApp: false, canManageNumbers: false,
    })
    expect(hubViewerFlags({ role: 'owner', rolesByLocation: { 'loc-1': 'owner' } }, null).isOwnerOrMaster).toBe(false)
  })
})

describe('loadHubLocationContext — the reads', () => {
  it('copies the old page\'s column lists', () => {
    const cols = (s) => s.split(',').map((c) => c.trim()).filter(Boolean)
    expect(cols(HUB_XERO_CONNECTION_COLUMNS)).toEqual([
      'location_id', 'tenant_id', 'tenant_name', 'tenant_type', 'connected_at', 'last_refreshed_at', 'expires_at',
      'scopes', 'bills_email_address', 'accounts_last_synced_at', 'contacts_last_synced_at', 'tax_rates_last_synced_at',
      'accounts_sync_error', 'contacts_sync_error', 'tax_rates_sync_error', 'car_sales_account_code',
    ])
    expect(cols(HUB_BCA_SAMPLE_CAR_COLUMNS)).toEqual([
      'uk_reg', 'irish_reg', 'vin', 'make', 'model', 'vehicle_year', 'buyer_name', 'buyer_email', 'xero_invoice_number',
    ])
  })

  it('a failed BCA sample read previews with no car and is logged, not thrown', async () => {
    const { logError } = await import('@/lib/log')
    const results = {
      locations: { data: { id: 'loc-1', organization_id: 'org-1', features: { bca_submit: true } }, error: null },
      xero_connections: { data: null, error: null },
      cars: { data: null, error: { message: 'cars exploded' } },
      channel_connections: { count: 0, error: null },
    }
    const db = {
      from(table) {
        const result = results[table]
        const b = {
          select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
          single: async () => result, maybeSingle: async () => result,
          then: (res, rej) => Promise.resolve(result).then(res, rej),
        }
        return b
      },
    }
    const { data, error } = await loadHubLocationContext(db, { role: 'master', profileRole: 'master' }, 'loc-1')
    expect(error).toBeNull()
    expect(data.sampleBcaCar).toBeNull()
    expect(data.xeroConnection).toBeNull()
    expect(data.xeroReadFailed).toBe(false)
    expect(logError).toHaveBeenCalledWith('integrations-hub-location', 'BCA sample car read failed', expect.objectContaining({ locationId: 'loc-1' }))
  })
})
