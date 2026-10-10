// W1.L1 — the host a customer-facing link is minted on, per tenant.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { platformHostnameFor, pickTenantHost, resolveCustomerBaseUrl, _resetTenantHostCache, RESERVED_PLATFORM_LABELS } from './tenant-host'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

const fakeDb = (rows, loc = { organization_id: 'org-a' }, org = { slug: 'gym-a' }) => ({
  from(table) {
    const b = { _t: table, select() { return b }, eq() { return b }, in() { return b }, order() { return b }, limit() { return b },
      maybeSingle: async () => (table === 'locations' ? { data: loc, error: null } : { data: org, error: null }),
      then(res) { return Promise.resolve({ data: table === 'tenant_domains' ? rows : null, error: null }).then(res) } }
    return b
  },
})

describe('tenant-host (W1.L1)', () => {
  beforeEach(() => { _resetTenantHostCache(); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.repset.ie') })

  it('the platform hostname is <slug>.repset.ie', () => {
    expect(platformHostnameFor('gym-a')).toBe('gym-a.repset.ie')
  })
  it('a custom row beats the platform row; a location-scoped row beats a whole-org row', () => {
    const rows = [
      { hostname: 'gym-a.repset.ie', source: 'platform', location_id: null },
      { hostname: 'www.gym-a.com', source: 'custom', location_id: null },
      { hostname: 'north.gym-a.com', source: 'custom', location_id: 'loc-a2' },
    ]
    expect(pickTenantHost(rows, 'loc-a1')).toBe('www.gym-a.com')
    expect(pickTenantHost(rows, 'loc-a2')).toBe('north.gym-a.com')
    expect(pickTenantHost([rows[0]], 'loc-a1')).toBe('gym-a.repset.ie')
    expect(pickTenantHost([], 'loc-a1')).toBe(null)
  })
  it('resolves https://<host> for a location, and falls back to the platform host with no rows', async () => {
    // The resolver caches per location, so each scenario starts cold.
    expect(await resolveCustomerBaseUrl(fakeDb([{ hostname: 'gym-a.repset.ie', source: 'platform', location_id: null }]), 'loc-a1')).toBe('https://gym-a.repset.ie')
    _resetTenantHostCache()
    expect(await resolveCustomerBaseUrl(fakeDb([]), 'loc-a1')).toBe('https://gym-a.repset.ie') // synthesised from org.slug
    _resetTenantHostCache()
    expect(await resolveCustomerBaseUrl(fakeDb([], null, null), 'loc-a1')).toBe('https://crm.repset.ie') // no org → platform CRM host
    expect(await resolveCustomerBaseUrl(null, null)).toBe('https://crm.repset.ie')
  })
  it('caches per location for the TTL (one lookup, not one per link)', async () => {
    let calls = 0
    const db = { from(t) { if (t === 'locations') calls++; return fakeDb([{ hostname: 'gym-a.repset.ie', source: 'platform', location_id: null }]).from(t) } }
    await resolveCustomerBaseUrl(db, 'loc-a1')
    await resolveCustomerBaseUrl(db, 'loc-a1')
    expect(calls).toBe(1)
  })
  it('only the location\'s own org\'s ACTIVE rows are considered (filter-aware double)', async () => {
    // The hand-rolled fake above ignores .eq(); this one really filters, so
    // dropping the organization_id / active filters in loadHostForLocation
    // would return another tenant's host or a parked one.
    const db = makeFakeDb({
      locations: [{ id: 'loc-a1', organization_id: 'org-a' }, { id: 'loc-b1', organization_id: 'org-b' }],
      organizations: [{ id: 'org-a', slug: 'gym-a' }, { id: 'org-b', slug: 'gym-b' }],
      tenant_domains: [
        { hostname: 'www.gym-b.com', organization_id: 'org-b', source: 'custom', location_id: null, active: true },
        { hostname: 'gym-b.repset.ie', organization_id: 'org-b', source: 'platform', location_id: null, active: true },
        { hostname: 'parked.gym-a.com', organization_id: 'org-a', source: 'custom', location_id: null, active: false },
        { hostname: 'gym-a.repset.ie', organization_id: 'org-a', source: 'platform', location_id: null, active: true },
      ],
    })
    expect(await resolveCustomerBaseUrl(db, 'loc-a1')).toBe('https://gym-a.repset.ie')
    _resetTenantHostCache()
    expect(await resolveCustomerBaseUrl(db, 'loc-b1')).toBe('https://www.gym-b.com')
  })
  it('reserved platform labels are the hosts the platform itself uses', () => {
    for (const label of ['www', 'crm', 'api', 'mail', 'host', 'pay', 'app', 'pm-bounces', 'wildcard-probe']) {
      expect(RESERVED_PLATFORM_LABELS).toContain(label)
    }
  })
  it('never throws on a db error — the CRM host is the floor', async () => {
    const db = { from() { throw new Error('boom') } }
    expect(await resolveCustomerBaseUrl(db, 'loc-a1')).toBe('https://crm.repset.ie')
  })
})
