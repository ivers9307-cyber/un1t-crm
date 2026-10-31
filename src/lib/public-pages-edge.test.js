// PAGES.1 — the edge's view of which landing pages are public. What's at stake:
// (1) the list comes from landing_pages rows that are live / coming soon /
// retired, cached for a minute; (2) a DB outage must keep the pages that were
// public before the table existed public (and invent none for another org);
// (3) the path matcher is exact on the first segment.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb } from './api-auth.test-helpers.js'
import { UN1T_GROUP_ORG_ID } from './brands.js'
import {
  listPublicPageSlugs,
  isPublicPagePath,
  publicOrgIdForHost,
  withPublicPageHeader,
  PUBLIC_PAGES_CACHE_TTL_MS,
  PUBLIC_PAGE_SLUGS_FALLBACK,
  _resetPublicPagesCache,
} from './public-pages-edge.js'
import { _resetTenantDomainsCache } from './tenant-domains-edge.js'

// The tenant tier reads tenant_domains through the edge client; hand it a fake.
let edgeDb = null
vi.mock('@supabase/ssr', () => ({ createServerClient: () => edgeDb }))

const ORG = 'org-acme'
const rows = [
  { organization_id: ORG, slug: 'january', kind: 'campaign', publish_state: 'live' },
  { organization_id: ORG, slug: 'soon', kind: 'campaign', publish_state: 'coming_soon' },
  { organization_id: ORG, slug: 'old', kind: 'campaign', publish_state: 'retired' },
  { organization_id: ORG, slug: 'draft', kind: 'campaign', publish_state: 'draft' },
  // PR1: a studio page is not admitted by the edge tier (still /welcome + PUBLIC_PATHS).
  { organization_id: ORG, slug: 'downtown', kind: 'studio', publish_state: 'live' },
  { organization_id: 'org-other', slug: 'elsewhere', kind: 'campaign', publish_state: 'live' },
]

function counted(db) {
  const spy = vi.fn((table) => db.from(table))
  return { from: spy, spy }
}

const throwingDb = { from: () => { throw new Error('db down') } }

beforeEach(() => {
  _resetPublicPagesCache()
  _resetTenantDomainsCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('listPublicPageSlugs', () => {
  it('lists live, coming_soon and retired slugs for the org, cached for 60s', async () => {
    const db = counted(makeFakeDb({ landing_pages: rows }))
    const first = await listPublicPageSlugs(ORG, { db, nowMs: 1000 })
    expect([...first].sort()).toEqual(['january', 'old', 'soon'])
    await listPublicPageSlugs(ORG, { db, nowMs: 1000 + PUBLIC_PAGES_CACHE_TTL_MS - 1 })
    expect(db.spy).toHaveBeenCalledTimes(1)
    await listPublicPageSlugs(ORG, { db, nowMs: 1000 + PUBLIC_PAGES_CACHE_TTL_MS })
    expect(db.spy).toHaveBeenCalledTimes(2)
  })

  it('caches per organisation', async () => {
    const db = counted(makeFakeDb({ landing_pages: rows }))
    expect(await listPublicPageSlugs('org-other', { db, nowMs: 5 })).toEqual(['elsewhere'])
    expect([...(await listPublicPageSlugs(ORG, { db, nowMs: 5 }))].sort()).toEqual(['january', 'old', 'soon'])
    expect(db.spy).toHaveBeenCalledTimes(2)
  })

  it('fallback when the read throws: UN1T Group answers the five campaign slugs (no studio page in PR1), an unknown org answers []', async () => {
    expect(await listPublicPageSlugs(UN1T_GROUP_ORG_ID, { db: throwingDb, nowMs: 1 }))
      .toEqual(['trial', '50plus', 'corp', 'start', 'free-class'])
    expect(await listPublicPageSlugs('org-unknown', { db: throwingDb, nowMs: 1 })).toEqual([])
    expect(PUBLIC_PAGE_SLUGS_FALLBACK[UN1T_GROUP_ORG_ID]).toHaveLength(5)
    expect(PUBLIC_PAGE_SLUGS_FALLBACK[UN1T_GROUP_ORG_ID]).not.toContain('stillorgan')
    expect(PUBLIC_PAGE_SLUGS_FALLBACK[UN1T_GROUP_ORG_ID]).not.toContain('hatch-street')
  })

  it('reads campaign pages only (PR1): a live studio page is not listed', async () => {
    const db = makeFakeDb({ landing_pages: rows })
    expect(await listPublicPageSlugs(ORG, { db, nowMs: 1 })).not.toContain('downtown')
  })

  it('an errored read answers the fallback too, and the failure is cached for the window', async () => {
    const failing = {
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: 'boom' } }) }) }) }),
      })),
    }
    expect(await listPublicPageSlugs(UN1T_GROUP_ORG_ID, { db: failing, nowMs: 1 })).toContain('trial')
    await listPublicPageSlugs(UN1T_GROUP_ORG_ID, { db: failing, nowMs: 2 })
    expect(failing.from).toHaveBeenCalledTimes(1)
  })

  it('no edge client configured (no env) answers the fallback without throwing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(await listPublicPageSlugs(UN1T_GROUP_ORG_ID, { nowMs: 1 })).toContain('trial')
  })

  it('a missing organisation id answers []', async () => {
    expect(await listPublicPageSlugs(null)).toEqual([])
  })
})

describe('isPublicPagePath', () => {
  const slugs = ['trial', 'january']
  it('matches the first segment only: /trial, /trial/x true; /trialx, /, /_next/a false', () => {
    expect(isPublicPagePath('/trial', slugs)).toBe(true)
    expect(isPublicPagePath('/trial/x', slugs)).toBe(true)
    expect(isPublicPagePath('/trialx', slugs)).toBe(false)
    expect(isPublicPagePath('/x/trial', slugs)).toBe(false)
    expect(isPublicPagePath('/', slugs)).toBe(false)
    expect(isPublicPagePath('', slugs)).toBe(false)
    expect(isPublicPagePath('/_next/a', ['_next'])).toBe(false)
    expect(isPublicPagePath('/trial', [])).toBe(false)
  })

  it('never admits a reserved app segment, even when the DB list names it', () => {
    const poisoned = ['trial', 'cars', 'settings', 'api', 'dashboard']
    expect(isPublicPagePath('/cars/x', poisoned)).toBe(false)
    expect(isPublicPagePath('/cars', poisoned)).toBe(false)
    expect(isPublicPagePath('/settings', poisoned)).toBe(false)
    expect(isPublicPagePath('/settings/staff', poisoned)).toBe(false)
    expect(isPublicPagePath('/api/contacts', poisoned)).toBe(false)
    expect(isPublicPagePath('/dashboard', poisoned)).toBe(false)
    expect(isPublicPagePath('/trial', poisoned)).toBe(true)
  })
})

describe('publicOrgIdForHost', () => {
  it('www.un1tdublin.com → UN1T Group; crm.un1tdublin.com → UN1T Group; a tenant host → its org', async () => {
    expect(await publicOrgIdForHost('www.un1tdublin.com')).toBe(UN1T_GROUP_ORG_ID)
    expect(await publicOrgIdForHost('crm.un1tdublin.com')).toBe(UN1T_GROUP_ORG_ID)
    expect(await publicOrgIdForHost('')).toBe(UN1T_GROUP_ORG_ID)
    // A tenant host resolves through the tenant_domains row, read by the edge client.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    edgeDb = makeFakeDb({
      tenant_domains: [{ id: 'td', hostname: 'members.acmegym.ie', organization_id: ORG, brand: {}, active: true }],
    })
    expect(await publicOrgIdForHost('members.acmegym.ie')).toBe(ORG)
    // An unmapped host falls back to UN1T Group.
    expect(await publicOrgIdForHost('nobody.example.com')).toBe(UN1T_GROUP_ORG_ID)
  })
})

describe('withPublicPageHeader', () => {
  it('returns a copy carrying x-public-page: 1 and leaves the original alone', () => {
    const original = new Headers({ host: 'a.example' })
    const next = withPublicPageHeader(original)
    expect(next.get('x-public-page')).toBe('1')
    expect(next.get('host')).toBe('a.example')
    expect(original.get('x-public-page')).toBe(null)
  })
})
