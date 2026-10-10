// W1.L4 — the favicon resolves by the REQUEST'S HOST: a tenant host gets its
// organisation's favicon (org_settings → the earliest active location's
// company_settings in that org), every other host (the CRM, an unmapped
// host) gets the PLATFORM mark. Before W1.L4 the resolver took the first
// configured company_settings row ESTATE-WIDE, so one tenant's icon labelled
// every tenant's tabs.
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeDb } from './api-auth.test-helpers.js'
import { _resetTenantDomainsCache } from './tenant-domains-edge.js'
import {
  PLATFORM_FAVICON_URL,
  FAVICON_CACHE_TTL_MS,
  resolveDefaultFaviconUrl,
  _resetDefaultFaviconCache,
} from './default-favicon.js'

const T0 = 1_800_000_000_000
const ORG_A = 'org-a'
const ORG_B = 'org-b'

function tables() {
  return {
    tenant_domains: [
      { id: 'td-a', hostname: 'gym-a.repset.ie', organization_id: ORG_A, brand: {}, active: true, source: 'platform', location_id: null },
      { id: 'td-b', hostname: 'gym-b.repset.ie', organization_id: ORG_B, brand: {}, active: true, source: 'platform', location_id: null },
    ],
    organizations: [{ id: ORG_A, slug: 'gym-a', master_location_id: null }, { id: ORG_B, slug: 'gym-b', master_location_id: null }],
    locations: [
      { id: 'loc-a1', name: 'Gym A', organization_id: ORG_A, active: true, created_at: '2026-01-01' },
      { id: 'loc-b1', name: 'Gym B', organization_id: ORG_B, active: true, created_at: '2026-01-02' },
    ],
    org_settings: [],
    company_settings: [],
  }
}

// Count DB round-trips (db.from calls) so the TTL-cache cases can assert
// "no second read inside the TTL".
function counted(t) {
  const db = makeFakeDb(t)
  const c = { calls: 0 }
  return { db: { from: (table) => { c.calls += 1; return db.from(table) } }, c }
}

beforeEach(() => {
  _resetDefaultFaviconCache()
  _resetTenantDomainsCache()
})

describe('PLATFORM_FAVICON_URL', () => {
  it('is the Repset mark served from public/ (the proxy matcher passes *.svg on every host)', () => {
    expect(PLATFORM_FAVICON_URL).toBe('/repset-mark.svg')
  })
})

describe('resolveDefaultFaviconUrl (W1.L4 — by host)', () => {
  it('a tenant host → that org\'s org_settings favicon', async () => {
    const t = tables()
    t.org_settings = [{ organization_id: ORG_A, company_name: 'Gym A', logo_url: null, favicon_url: 'https://cdn/a-org.png' }]
    expect(await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db: makeFakeDb(t), nowMs: T0 })).toBe('https://cdn/a-org.png')
  })

  it('a tenant host → the earliest active location\'s company_settings favicon when the org has none', async () => {
    const t = tables()
    t.company_settings = [{ location_id: 'loc-a1', company_name: 'Gym A', logo_url: null, favicon_url: 'https://cdn/a-loc.png' }]
    expect(await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie:443', db: makeFakeDb(t), nowMs: T0 })).toBe('https://cdn/a-loc.png')
  })

  it('the CRM host → the platform mark, whatever company_settings holds (never the first row)', async () => {
    const t = tables()
    t.company_settings = [{ location_id: 'loc-a1', company_name: 'Gym A', logo_url: null, favicon_url: 'https://cdn/a-loc.png' }]
    expect(await resolveDefaultFaviconUrl({ host: 'crm.repset.ie', db: makeFakeDb(t), nowMs: T0 })).toBe(PLATFORM_FAVICON_URL)
    _resetDefaultFaviconCache()
    expect(await resolveDefaultFaviconUrl({ host: '', db: makeFakeDb(t), nowMs: T0 })).toBe(PLATFORM_FAVICON_URL)
    _resetDefaultFaviconCache()
    expect(await resolveDefaultFaviconUrl({ db: makeFakeDb(t), nowMs: T0 })).toBe(PLATFORM_FAVICON_URL)
  })

  it('a second tenant\'s company_settings row cannot change another tenant\'s favicon', async () => {
    const t = tables()
    t.company_settings = [{ location_id: 'loc-b1', company_name: 'Gym B', logo_url: null, favicon_url: 'https://cdn/b.png' }]
    expect(await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db: makeFakeDb(t), nowMs: T0 })).toBe(PLATFORM_FAVICON_URL)
    expect(await resolveDefaultFaviconUrl({ host: 'gym-b.repset.ie', db: makeFakeDb(t), nowMs: T0 })).toBe('https://cdn/b.png')
  })

  it('falls back to the platform mark when the client throws (never throws itself)', async () => {
    const db = { from() { throw new Error('network down') } }
    expect(await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 })).toBe(PLATFORM_FAVICON_URL)
  })

  it('caches PER HOST inside the TTL — a second call for the same host does not re-query', async () => {
    const t = tables()
    t.org_settings = [{ organization_id: ORG_A, favicon_url: 'https://cdn/a.png' }]
    const { db, c } = counted(t)
    await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 })
    const reads = c.calls
    expect(await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 + FAVICON_CACHE_TTL_MS - 1 })).toBe('https://cdn/a.png')
    expect(c.calls).toBe(reads)
  })

  it('re-queries once the TTL has elapsed (picks up a new upload)', async () => {
    const t = tables()
    t.org_settings = [{ organization_id: ORG_A, favicon_url: 'https://cdn/old.png' }]
    const db = makeFakeDb(t)
    await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 })
    t.org_settings[0].favicon_url = 'https://cdn/new.png'
    expect(await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 + FAVICON_CACHE_TTL_MS })).toBe('https://cdn/new.png')
  })

  it('caches the fallback too, so a down DB is not hammered per-request', async () => {
    let calls = 0
    const db = { from() { calls += 1; throw new Error('down') } }
    await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 })
    await resolveDefaultFaviconUrl({ host: 'gym-a.repset.ie', db, nowMs: T0 + 1 })
    expect(calls).toBe(1)
  })
})
