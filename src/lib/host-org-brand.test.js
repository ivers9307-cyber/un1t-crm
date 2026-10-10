// W1.S1c — the organisation brand the host portal and host emails speak for.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('./tenant-domains-edge', () => ({ resolveTenantOrgId: vi.fn() }))

import {
  resolveOrgBrand,
  resolveHostOrgBrand,
  resolveRequestHostOrgBrand,
  _resetHostOrgBrandCache,
  HOST_ORG_BRAND_CACHE_TTL_MS,
} from './host-org-brand.js'
import { resolveTenantOrgId } from './tenant-domains-edge'
import { PLATFORM_NAME } from './brand-name'

const ORG = 'f117b7b8-5f56-4f80-8299-2c698242e4d2'

// tables: { org_settings: [...], organizations: [...], locations: [...] }
// fail: every read errors; failTables: only reads of these tables error.
function makeDb(tables = {}, { fail = false, failTables = [] } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      reads.push(table)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const res = fail || failTables.includes(table)
              ? { data: null, error: { message: 'down' } }
              : { data: tables[table] || [], error: null }
            const p = Promise.resolve(res)
            return p.then.bind(p)
          }
          return () => b
        },
      })
      return b
    },
  }
}

beforeEach(() => {
  _resetHostOrgBrandCache()
  vi.clearAllMocks()
})

describe('resolveOrgBrand', () => {
  it('reads the org brand for sentences and the short name for the wordmark', async () => {
    const db = makeDb({ org_settings: [{ company_name: 'UN1T Dublin', short_name: 'UN1T' }] })
    expect(await resolveOrgBrand(db, ORG)).toEqual({ name: 'UN1T Dublin', shortName: 'UN1T' })
  })

  it('a short name falls back to the brand, so another gym reads its own name in both', async () => {
    const db = makeDb({ org_settings: [{ company_name: 'Pulse Gym', short_name: null }] })
    expect(await resolveOrgBrand(db, ORG)).toEqual({ name: 'Pulse Gym', shortName: 'Pulse Gym' })
  })

  it('an org with no settings row reads its master location name, never a literal', async () => {
    const db = makeDb({ organizations: [{ master_location_id: 'loc-1' }], locations: [{ name: 'Pulse Rathmines' }] })
    expect(await resolveOrgBrand(db, ORG)).toEqual({ name: 'Pulse Rathmines', shortName: 'Pulse Rathmines' })
  })

  it('floors on the platform name when nothing resolves, and when the reads fail', async () => {
    expect(await resolveOrgBrand(makeDb({}), ORG)).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
    expect(await resolveOrgBrand(makeDb({}, { fail: true }), ORG)).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
    expect(await resolveOrgBrand(null, ORG)).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
    expect(await resolveOrgBrand(makeDb({}), null)).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
  })

  it('caches a resolved brand per org for the TTL, and never caches the floor', async () => {
    const db = makeDb({ org_settings: [{ company_name: 'UN1T Dublin', short_name: 'UN1T' }] })
    await resolveOrgBrand(db, ORG, { nowMs: 0 })
    const after = db.reads.length
    await resolveOrgBrand(db, ORG, { nowMs: HOST_ORG_BRAND_CACHE_TTL_MS - 1 })
    expect(db.reads.length).toBe(after)
    await resolveOrgBrand(db, ORG, { nowMs: HOST_ORG_BRAND_CACHE_TTL_MS + 1 })
    expect(db.reads.length).toBeGreaterThan(after)

    const empty = makeDb({})
    await resolveOrgBrand(empty, 'org-2', { nowMs: 0 })
    const first = empty.reads.length
    await resolveOrgBrand(empty, 'org-2', { nowMs: 1 })
    expect(empty.reads.length).toBe(first * 2)
  })

  it('does not cache a brand read while the org_settings read failed', async () => {
    // org_settings down: the name falls through to the master location, the
    // short name is unknown. Serve it, but retry next render rather than
    // pinning the long name in the wordmark for the TTL.
    const tables = {
      org_settings: [{ company_name: 'UN1T Dublin', short_name: 'UN1T' }],
      organizations: [{ master_location_id: 'loc-1' }],
      locations: [{ name: 'UN1T Stillorgan' }],
    }
    const down = makeDb(tables, { failTables: ['org_settings'] })
    expect(await resolveOrgBrand(down, ORG, { nowMs: 0 })).toEqual({ name: 'UN1T Stillorgan', shortName: 'UN1T Stillorgan' })

    const up = makeDb(tables)
    expect(await resolveOrgBrand(up, ORG, { nowMs: 1 })).toEqual({ name: 'UN1T Dublin', shortName: 'UN1T' })
    expect(up.reads).toContain('org_settings')
  })
})

describe('resolveHostOrgBrand', () => {
  it("resolves through the host's organisation, never the host's own name", async () => {
    const db = makeDb({ org_settings: [{ company_name: 'UN1T Dublin', short_name: 'UN1T' }] })
    const host = { id: 'h1', name: 'Pride Training Club', organization_id: ORG, anchor_location_id: 'anchor' }
    expect(await resolveHostOrgBrand(db, host)).toEqual({ name: 'UN1T Dublin', shortName: 'UN1T' })
  })

  it('a host row without an organisation reads the platform name', async () => {
    expect(await resolveHostOrgBrand(makeDb({}), { id: 'h1' })).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
  })
})

describe('resolveRequestHostOrgBrand (pre-auth host pages)', () => {
  it("a tenant host reads its organisation's brand", async () => {
    resolveTenantOrgId.mockResolvedValue(ORG)
    const db = makeDb({ org_settings: [{ company_name: 'UN1T Dublin', short_name: 'UN1T' }] })
    expect(await resolveRequestHostOrgBrand('host.un1tdublin.com', { db })).toEqual({ name: 'UN1T Dublin', shortName: 'UN1T' })
    expect(resolveTenantOrgId).toHaveBeenCalledWith('host.un1tdublin.com', { db })
  })

  it('a failed tenant lookup reads the platform name', async () => {
    resolveTenantOrgId.mockRejectedValue(new Error('down'))
    expect(await resolveRequestHostOrgBrand('gym-a.repset.ie', { db: makeDb({}) })).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
  })

  it('the CRM host (no organisation) reads the platform name', async () => {
    resolveTenantOrgId.mockResolvedValue(null)
    expect(await resolveRequestHostOrgBrand('crm.repset.ie', { db: makeDb({}) })).toEqual({ name: PLATFORM_NAME, shortName: PLATFORM_NAME })
  })
})
