// SAAS-8 — DB tier of the brand registry. What's really at stake:
// (1) an unknown hostname WITHOUT a row must behave exactly like
// today — fall through to the CRM auth gate — even when the DB is
// down (fail-safe null); (2) the cache must bound the cost to one
// fetch per TTL window, failures included; (3) a row's brand jsonb
// must normalise into the exact shape the proxy's handler switch
// expects, whatever is in the column.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb } from './api-auth.test-helpers.js'
import {
  resolveTenantDomainBrand,
  resolveTenantOrgId,
  resolveTenantLocationId,
  DB_BRAND_DEFAULTS,
  TENANT_DOMAINS_CACHE_TTL_MS,
  _resetTenantDomainsCache,
} from './tenant-domains-edge.js'

const ROW = {
  id: 'td-1',
  hostname: 'members.acmegym.ie',
  organization_id: 'org-acme',
  brand: {},
  active: true,
}

function fixture(rows = [ROW]) {
  return makeFakeDb({ tenant_domains: rows })
}

// Wrap a fake db so we can count fetches (db.from calls).
function counted(db) {
  const spy = vi.fn((table) => db.from(table))
  return { from: spy, spy }
}

beforeEach(() => {
  _resetTenantDomainsCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveTenantDomainBrand — resolution', () => {
  it('active row → brand in the resolveBrand shape, plus organizationId', async () => {
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db: fixture() })
    expect(brand).toMatchObject({
      id: 'tenant:members.acmegym.ie',
      hostnames: ['members.acmegym.ie'],
      organizationId: 'org-acme',
    })
    // Same contract brands.test.js pins for in-code entries.
    expect(['reject', 'rewrite']).toContain(brand.rootHandler)
    expect(['reject', 'rewrite']).toContain(brand.fallbackHandler)
    expect(Array.isArray(brand.allowedPaths)).toBe(true)
  })

  it('empty brand jsonb ({} — the column default) → marketing defaults', async () => {
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db: fixture() })
    expect(brand.rootHandler).toBe('rewrite')
    expect(brand.rootRewriteTo).toBe('/welcome')
    expect(brand.fallbackHandler).toBe('rewrite')
    expect(brand.fallbackRewriteTo).toBe('/welcome')
    expect(brand.allowedPaths).toEqual([...DB_BRAND_DEFAULTS.allowedPaths])
  })

  it('brand overrides are honoured (reject/reject payment-style row)', async () => {
    const db = fixture([{
      ...ROW,
      brand: { rootHandler: 'reject', fallbackHandler: 'reject', allowedPaths: ['/deposit/'], description: 'Acme pay' },
    }])
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db })
    expect(brand.rootHandler).toBe('reject')
    expect(brand.fallbackHandler).toBe('reject')
    expect(brand.allowedPaths).toEqual(['/deposit/'])
    expect(brand.description).toBe('Acme pay')
  })

  it('an explicitly EMPTY allowedPaths is honoured (lock-down), not defaulted', async () => {
    const db = fixture([{ ...ROW, brand: { allowedPaths: [] } }])
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db })
    expect(brand.allowedPaths).toEqual([])
  })

  it('garbage brand values normalise to safe defaults (never an unhandled mode)', async () => {
    const db = fixture([{
      ...ROW,
      brand: { rootHandler: 'banana', rootRewriteTo: 'welcome', fallbackHandler: 42, allowedPaths: ['/ok/', 'no-slash', 7] },
    }])
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db })
    expect(brand.rootHandler).toBe('rewrite')
    expect(brand.rootRewriteTo).toBe('/welcome')
    expect(brand.fallbackHandler).toBe('rewrite')
    expect(brand.allowedPaths).toEqual(['/ok/'])
  })

  it('inactive row → null (soft kill switch falls through to the CRM gate)', async () => {
    const db = fixture([{ ...ROW, active: false }])
    expect(await resolveTenantDomainBrand('members.acmegym.ie', { db })).toBe(null)
  })

  it('unknown host with no row → null (today\'s behaviour, pinned)', async () => {
    expect(await resolveTenantDomainBrand('nobody.example.com', { db: fixture() })).toBe(null)
  })

  it('strips port suffix and lowercases before matching (rows store lowercase)', async () => {
    const db = fixture()
    expect((await resolveTenantDomainBrand('members.acmegym.ie:3000', { db }))?.organizationId).toBe('org-acme')
    expect((await resolveTenantDomainBrand('MEMBERS.ACMEGYM.IE', { db }))?.organizationId).toBe('org-acme')
  })

  it('returns null for empty / malformed input without touching the DB', async () => {
    const { from, spy } = counted(fixture())
    expect(await resolveTenantDomainBrand('', { db: { from } })).toBe(null)
    expect(await resolveTenantDomainBrand(null, { db: { from } })).toBe(null)
    expect(await resolveTenantDomainBrand(undefined, { db: { from } })).toBe(null)
    expect(await resolveTenantDomainBrand(42, { db: { from } })).toBe(null)
    expect(spy).not.toHaveBeenCalled()
  })

  it('the CRM\'s own hostname (NEXT_PUBLIC_APP_URL) never consults this tier', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.un1tdublin.com')
    // Even a (mistaken) row for it cannot brand-gate the staff CRM.
    const db = counted(fixture([{ ...ROW, hostname: 'crm.un1tdublin.com' }]))
    expect(await resolveTenantDomainBrand('crm.un1tdublin.com', { db })).toBe(null)
    expect(db.spy).not.toHaveBeenCalled()
  })

  // REPSET-P6 — dual-domain: BOTH CRM hosts skip this tier, even when
  // NEXT_PUBLIC_APP_URL names only one of them (prod config). Neither
  // host ever pays the DB lookup, and a mistaken row can never
  // brand-gate the staff CRM on either domain.
  it('EVERY CRM host in the set skips this tier, whatever NEXT_PUBLIC_APP_URL says', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.un1tdublin.com')
    for (const host of ['crm.un1tdublin.com', 'crm.repset.ie']) {
      _resetTenantDomainsCache()
      const db = counted(fixture([{ ...ROW, hostname: host }]))
      expect(await resolveTenantDomainBrand(host, { db })).toBe(null)
      expect(db.spy).not.toHaveBeenCalled()
    }
  })

  it('CRM hosts skip this tier case-insensitively and with a port suffix', async () => {
    const db = counted(fixture([{ ...ROW, hostname: 'crm.repset.ie' }]))
    expect(await resolveTenantDomainBrand('CRM.Repset.IE:3000', { db })).toBe(null)
    expect(db.spy).not.toHaveBeenCalled()
  })
})

describe('resolveTenantDomainBrand — TTL cache', () => {
  it('one fetch per TTL window; refetches after expiry', async () => {
    const db = counted(fixture())
    await resolveTenantDomainBrand('members.acmegym.ie', { db, nowMs: 1000 })
    await resolveTenantDomainBrand('other.example.com', { db, nowMs: 2000 })
    expect(db.spy).toHaveBeenCalledTimes(1)
    await resolveTenantDomainBrand('members.acmegym.ie', { db, nowMs: 1000 + TENANT_DOMAINS_CACHE_TTL_MS + 1 })
    expect(db.spy).toHaveBeenCalledTimes(2)
  })

  it('a DB error resolves null AND is cached — one attempt per window, not per request', async () => {
    const broken = { from: vi.fn(() => { throw new Error('db down') }) }
    expect(await resolveTenantDomainBrand('members.acmegym.ie', { db: broken, nowMs: 1000 })).toBe(null)
    // Second call inside the window: still null, no second attempt —
    // even though a working db is now offered (the failure is cached).
    const healthy = counted(fixture())
    expect(await resolveTenantDomainBrand('members.acmegym.ie', { db: healthy, nowMs: 2000 })).toBe(null)
    expect(healthy.spy).not.toHaveBeenCalled()
    // After the TTL the healthy db is consulted and the row resolves.
    const after = await resolveTenantDomainBrand('members.acmegym.ie', { db: healthy, nowMs: 1000 + TENANT_DOMAINS_CACHE_TTL_MS + 1 })
    expect(after?.organizationId).toBe('org-acme')
  })

  it('a PostgREST-level error ({ data: null, error }) also resolves null', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
      }),
    }
    expect(await resolveTenantDomainBrand('members.acmegym.ie', { db })).toBe(null)
  })

  it('missing service-role env → null, no throw (build-time / stub-env safety)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(await resolveTenantDomainBrand('members.acmegym.ie')).toBe(null)
  })
})

describe('resolveTenantOrgId — the SAAS-6/7 handoff seam', () => {
  it('mapped host → that org\'s id (welcome chooser renders THAT org)', async () => {
    expect(await resolveTenantOrgId('members.acmegym.ie', { db: fixture() })).toBe('org-acme')
  })

  it('unmapped host → null (welcome keeps its UN1T slug fallback byte-identical)', async () => {
    // un1tdublin.com deliberately has no row (in-code tier owns it).
    expect(await resolveTenantOrgId('un1tdublin.com', { db: fixture() })).toBe(null)
  })
})

describe('per-location scoping (mig 432)', () => {
  it('brand carries locationId null for a whole-org row (unchanged shape)', async () => {
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db: fixture() })
    expect(brand.locationId).toBe(null)
  })

  it('brand carries locationId for a location-scoped row', async () => {
    const db = fixture([{ ...ROW, location_id: 'loc-central' }])
    const brand = await resolveTenantDomainBrand('members.acmegym.ie', { db })
    expect(brand.locationId).toBe('loc-central')
    // The rewrite targets are UNCHANGED — the location only steers the
    // /welcome render, never the proxy's rewrite. Routing stays identical.
    expect(brand.rootRewriteTo).toBe('/welcome')
    expect(brand.fallbackRewriteTo).toBe('/welcome')
  })

  it('resolveTenantLocationId → the scoped location for a location row', async () => {
    const db = fixture([{ ...ROW, location_id: 'loc-central' }])
    expect(await resolveTenantLocationId('members.acmegym.ie', { db })).toBe('loc-central')
  })

  it('resolveTenantLocationId → null for a whole-org row (chooser byte-identical)', async () => {
    expect(await resolveTenantLocationId('members.acmegym.ie', { db: fixture() })).toBe(null)
  })

  it('resolveTenantLocationId → null for an unmapped host', async () => {
    expect(await resolveTenantLocationId('un1tdublin.com', { db: fixture() })).toBe(null)
  })
})
