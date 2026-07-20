import { describe, it, expect, vi } from 'vitest'
import { shapeTenantPrivacyEntity, getTenantPrivacyEntity } from './tenant-privacy.js'

describe('shapeTenantPrivacyEntity (SAAS4-C2)', () => {
  it('returns the entity when the legally required fields are present', () => {
    expect(
      shapeTenantPrivacyEntity({
        legal_entity_name: 'FitCo Ltd',
        legal_trading_name: 'FitCo',
        legal_address: '1 Main St, Dublin',
        privacy_contact_email: 'privacy@fitco.ie',
      })
    ).toEqual({
      entityName: 'FitCo Ltd',
      tradingName: 'FitCo',
      address: '1 Main St, Dublin',
      contactEmail: 'privacy@fitco.ie',
    })
  })

  it('returns null when entity name or contact email is missing — NEVER render a half-filled legal page', () => {
    expect(shapeTenantPrivacyEntity({ legal_entity_name: 'FitCo Ltd' })).toBeNull()
    expect(shapeTenantPrivacyEntity({ privacy_contact_email: 'x@y.ie' })).toBeNull()
    expect(shapeTenantPrivacyEntity(null)).toBeNull()
  })

  it('tolerates missing optional fields (trading name, address)', () => {
    const out = shapeTenantPrivacyEntity({
      legal_entity_name: 'FitCo Ltd',
      privacy_contact_email: 'privacy@fitco.ie',
    })
    expect(out).toMatchObject({ entityName: 'FitCo Ltd', contactEmail: 'privacy@fitco.ie' })
    expect(out.tradingName).toBeNull()
    expect(out.address).toBeNull()
  })
})

describe('getTenantPrivacyEntity (SAAS4-C2)', () => {
  it('resolves the org from the host and returns its shaped entity', async () => {
    const db = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { legal_entity_name: 'FitCo Ltd', privacy_contact_email: 'privacy@fitco.ie' },
            }),
          }),
        }),
      })),
    }
    const entity = await getTenantPrivacyEntity('fitco.un1tdublin.com', {
      db,
      resolveOrg: async () => 'org-1',
    })
    expect(entity).toMatchObject({ entityName: 'FitCo Ltd' })
  })

  it('returns null (→ platform copy) for non-tenant hosts and on any error', async () => {
    expect(await getTenantPrivacyEntity('crm.un1tdublin.com', { resolveOrg: async () => null })).toBeNull()
    expect(
      await getTenantPrivacyEntity('x.ie', {
        resolveOrg: async () => {
          throw new Error('edge down')
        },
      })
    ).toBeNull()
  })
})
