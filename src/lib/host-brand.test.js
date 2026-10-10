// W1.L4 — the one per-host brand cache, and the scoped-name rule the
// unsubscribe page uses for its `?l=` location hint.
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeDb } from './api-auth.test-helpers.js'
import { _resetTenantDomainsCache } from './tenant-domains-edge.js'
import { UN1T_GROUP_ORG_ID } from './brands.js'
import {
  HOST_BRAND_CACHE_TTL_MS,
  resolveHostBrand,
  resolveScopedBrandName,
  isUuidLike,
  _resetHostBrandCache,
} from './host-brand.js'

const T0 = 1_800_000_000_000
const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const LOC_B1 = 'bbbbbbbb-0000-4000-8000-000000000001'

function tables() {
  return {
    tenant_domains: [
      { id: 'td-a', hostname: 'gym-a.repset.ie', organization_id: ORG_A, brand: {}, active: true, source: 'platform', location_id: null },
      { id: 'td-b', hostname: 'gym-b.repset.ie', organization_id: ORG_B, brand: {}, active: true, source: 'platform', location_id: null },
    ],
    organizations: [{ id: ORG_A, slug: 'gym-a', master_location_id: null }, { id: ORG_B, slug: 'gym-b', master_location_id: null }],
    locations: [
      { id: LOC_A1, name: 'Gym A North', organization_id: ORG_A, active: true, created_at: '2026-01-01' },
      { id: LOC_B1, name: 'Gym B', organization_id: ORG_B, active: true, created_at: '2026-01-02' },
    ],
    org_settings: [{ organization_id: ORG_A, company_name: 'Gym A', logo_url: 'https://cdn/a.png', favicon_url: null }],
    company_settings: [
      { location_id: LOC_A1, company_name: 'Gym A North', logo_url: null, favicon_url: 'https://cdn/a.ico' },
      { location_id: LOC_B1, company_name: 'Gym B', logo_url: 'https://cdn/b.png', favicon_url: 'https://cdn/b.ico' },
    ],
  }
}

// Count DB round-trips per table.
function counted(t) {
  const inner = makeFakeDb(t)
  const calls = {}
  const db = { from(table) { calls[table] = (calls[table] || 0) + 1; return inner.from(table) } }
  return { db, calls, total: () => Object.values(calls).reduce((a, b) => a + b, 0) }
}

beforeEach(() => {
  _resetHostBrandCache()
  _resetTenantDomainsCache()
})

describe('resolveHostBrand', () => {
  it('a tenant host → that org\'s brand per field; the CRM host → the empty brand', async () => {
    expect(await resolveHostBrand({ host: 'gym-a.repset.ie', db: makeFakeDb(tables()), nowMs: T0 })).toEqual({
      orgId: ORG_A, companyName: 'Gym A', logoUrl: 'https://cdn/a.png', faviconUrl: 'https://cdn/a.ico',
    })
    expect(await resolveHostBrand({ host: 'crm.repset.ie', db: makeFakeDb(tables()), nowMs: T0 })).toEqual({
      orgId: null, companyName: '', logoUrl: null, faviconUrl: null,
    })
  })

  it('normalises the host: case, port and a trailing dot are one cache entry and one tenant', async () => {
    const { db, total } = counted(tables())
    expect((await resolveHostBrand({ host: 'GYM-A.repset.ie:443', db, nowMs: T0 })).companyName).toBe('Gym A')
    const after = total()
    expect((await resolveHostBrand({ host: 'gym-a.repset.ie.', db, nowMs: T0 + 1 })).companyName).toBe('Gym A')
    expect((await resolveHostBrand({ host: 'gym-a.repset.ie', db, nowMs: T0 + 2 })).companyName).toBe('Gym A')
    expect(total()).toBe(after)
  })

  it('an in-code host resolves through brands.js (un1tdublin.com → UN1T Group)', async () => {
    const t = tables()
    t.org_settings.push({ organization_id: UN1T_GROUP_ORG_ID, company_name: 'UN1T Dublin', logo_url: null, favicon_url: null })
    expect((await resolveHostBrand({ host: 'WWW.UN1TDUBLIN.COM', db: makeFakeDb(t), nowMs: T0 })).companyName).toBe('UN1T Dublin')
  })

  it('ONE walk per host per TTL, shared by every consumer; re-walks after the TTL', async () => {
    const { db, total } = counted(tables())
    await resolveHostBrand({ host: 'gym-a.repset.ie', db, nowMs: T0 })
    const walk = total()
    expect(walk).toBeGreaterThan(0)
    expect(walk).toBeLessThanOrEqual(4)
    await resolveHostBrand({ host: 'gym-a.repset.ie', db, nowMs: T0 + HOST_BRAND_CACHE_TTL_MS - 1 })
    expect(total()).toBe(walk)
    await resolveHostBrand({ host: 'gym-a.repset.ie', db, nowMs: T0 + HOST_BRAND_CACHE_TTL_MS })
    expect(total()).toBeGreaterThan(walk)
  })

  it('caches the miss and the failure too, and never throws', async () => {
    let calls = 0
    const db = { from() { calls += 1; throw new Error('down') } }
    expect(await resolveHostBrand({ host: 'gym-a.repset.ie', db, nowMs: T0 })).toEqual({ orgId: null, companyName: '', logoUrl: null, faviconUrl: null })
    await resolveHostBrand({ host: 'gym-a.repset.ie', db, nowMs: T0 + 1 })
    expect(calls).toBe(1)
  })
})

describe('isUuidLike', () => {
  it('accepts a Postgres-permissive UUID and nothing else', () => {
    expect(isUuidLike(LOC_A1)).toBe(true)
    expect(isUuidLike(LOC_A1.toUpperCase())).toBe(true)
    expect(isUuidLike('not-a-uuid')).toBe(false)
    expect(isUuidLike('')).toBe(false)
    expect(isUuidLike(null)).toBe(false)
    expect(isUuidLike(42)).toBe(false)
  })
})

describe('resolveScopedBrandName — the `?l=` hint can never name another tenant', () => {
  it('a location of the host\'s own org → that location\'s brand', async () => {
    expect(await resolveScopedBrandName({ host: 'gym-a.repset.ie', locationId: LOC_A1, db: makeFakeDb(tables()), nowMs: T0 })).toBe('Gym A North')
  })

  it('BLOCKER regression: host gym-a + ?l=<gym B\'s location> → Gym A\'s brand, never Gym B\'s', async () => {
    expect(await resolveScopedBrandName({ host: 'gym-a.repset.ie', locationId: LOC_B1, db: makeFakeDb(tables()), nowMs: T0 })).toBe('Gym A')
  })

  it('a CRM-host link (no org) honours the hint — that is where every link was minted before W1.L3', async () => {
    expect(await resolveScopedBrandName({ host: 'crm.repset.ie', locationId: LOC_B1, db: makeFakeDb(tables()), nowMs: T0 })).toBe('Gym B')
  })

  it('a non-UUID hint costs no read and reads the host brand (the platform on the CRM host)', async () => {
    const { db, total } = counted(tables())
    expect(await resolveScopedBrandName({ host: 'crm.repset.ie', locationId: 'not-a-uuid', db, nowMs: T0 })).toBe('Repset')
    expect(total()).toBe(0)
    expect(await resolveScopedBrandName({ host: 'crm.repset.ie', locationId: "' OR 1=1", db, nowMs: T0 })).toBe('Repset')
    expect(total()).toBe(0)
  })

  it('an unknown UUID and a DB failure both floor on the host brand', async () => {
    expect(await resolveScopedBrandName({ host: 'gym-a.repset.ie', locationId: 'cccccccc-0000-4000-8000-000000000001', db: makeFakeDb(tables()), nowMs: T0 })).toBe('Gym A')
    _resetHostBrandCache()
    const db = { from() { throw new Error('down') } }
    expect(await resolveScopedBrandName({ host: 'gym-a.repset.ie', locationId: LOC_A1, db, nowMs: T0 })).toBe('Repset')
  })
})
