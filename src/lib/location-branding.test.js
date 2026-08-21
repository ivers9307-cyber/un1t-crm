import { describe, it, expect } from 'vitest'
import { getLocationBranding } from './location-branding.js'

// supabase-builder mock that dispatches by table name. Each query is
// `from(table).select().eq().limit()` and resolves to results[table]
// (default: empty success). The helper runs its queries sequentially, so the
// single mutable `_table` is safe.
function mockDb(results) {
  return {
    _table: null,
    from(table) { this._table = table; return this },
    select() { return this },
    eq() { return this },
    limit() { return Promise.resolve(results[this._table] ?? { data: [], error: null }) },
  }
}

const loc = (rows) => ({ company_settings: { data: rows, error: null } })
const withOrg = (locRows, orgId, orgRows) => ({
  company_settings: { data: locRows, error: null },
  locations: { data: orgId ? [{ organization_id: orgId }] : [], error: null },
  org_settings: { data: orgRows, error: null },
})

describe('getLocationBranding', () => {
  it('returns the configured company name + assets (location level)', async () => {
    const db = mockDb(loc([{ company_name: 'CCF Autos', logo_url: 'l.png', favicon_url: 'f.ico' }]))
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'CCF Autos', companyNameConfigured: true, logoUrl: 'l.png', faviconUrl: 'f.ico' })
  })

  it('a fully-configured location wins over org defaults (no inheritance)', async () => {
    const db = mockDb(withOrg(
      [{ company_name: 'Stillorgan', logo_url: 'loc.png', favicon_url: 'loc.ico' }],
      'org1',
      [{ company_name: 'UN1T Group', logo_url: 'org.png', favicon_url: 'org.ico' }],
    ))
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'Stillorgan', companyNameConfigured: true, logoUrl: 'loc.png', faviconUrl: 'loc.ico' })
  })

  it('inherits the org brand when the location has no row', async () => {
    const db = mockDb(withOrg([], 'org1', [{ company_name: 'CCF Autos', logo_url: 'org.png', favicon_url: 'org.ico' }]))
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'CCF Autos', companyNameConfigured: true, logoUrl: 'org.png', faviconUrl: 'org.ico' })
  })

  it('merges per field — location name kept, org fills the missing logo/favicon', async () => {
    const db = mockDb(withOrg(
      [{ company_name: 'Stillorgan', logo_url: null, favicon_url: null }],
      'org1',
      [{ company_name: 'UN1T Group', logo_url: 'org.png', favicon_url: 'org.ico' }],
    ))
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'Stillorgan', companyNameConfigured: true, logoUrl: 'org.png', faviconUrl: 'org.ico' })
  })

  it('falls back to UN1T when neither location nor org is configured', async () => {
    const db = mockDb(withOrg([], 'org1', []))
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'UN1T', companyNameConfigured: false, logoUrl: null, faviconUrl: null })
  })

  it('falls back to UN1T when company_name is blank and there is no org name', async () => {
    const db = mockDb(withOrg([{ company_name: '   ', logo_url: null, favicon_url: null }], 'org1', []))
    expect((await getLocationBranding(db, 'loc1')).companyName).toBe('UN1T')
  })

  it('returns defaults (never throws) on a query error', async () => {
    const db = mockDb({ company_settings: { data: null, error: { message: 'boom' } }, locations: { data: [], error: null } })
    expect(await getLocationBranding(db, 'loc1')).toEqual({ companyName: 'UN1T', companyNameConfigured: false, logoUrl: null, faviconUrl: null })
  })

  it('returns defaults when locationId is missing', async () => {
    expect(await getLocationBranding(mockDb({}), null)).toEqual({ companyName: 'UN1T', companyNameConfigured: false, logoUrl: null, faviconUrl: null })
  })
})

// LEGALENT.2 — companyNameConfigured separates "an operator named this
// business" from "nobody did, so here is the module's own literal".
// Every existing caller renders a wordmark, for which the default is
// the right answer; a caller making a CLAIM about a company — a
// contract countersignature, a party clause — must not print the gym's
// brand on another org's binding document, so it reads this flag. In
// production (measured 2026-08-20) every company_settings.company_name
// and every org_settings.company_name is NULL, so the flag is false
// estate-wide and this is not a hypothetical branch.
describe('getLocationBranding — companyNameConfigured', () => {
  it('is true when a location configured the name', async () => {
    const db = mockDb(loc([{ company_name: 'CCF Autos', logo_url: 'l.png', favicon_url: 'f.ico' }]))
    expect((await getLocationBranding(db, 'loc1')).companyNameConfigured).toBe(true)
  })

  it('is true when the name is inherited from the org', async () => {
    const db = mockDb(withOrg([], 'org1', [{ company_name: 'CCF Autos', logo_url: null, favicon_url: null }]))
    const out = await getLocationBranding(db, 'loc1')
    expect(out.companyName).toBe('CCF Autos')
    expect(out.companyNameConfigured).toBe(true)
  })

  it('is FALSE whenever companyName is only the module default', async () => {
    for (const db of [
      mockDb(withOrg([], 'org1', [])),                                                   // nothing set anywhere
      mockDb(withOrg([{ company_name: '   ', logo_url: null, favicon_url: null }], 'org1', [])), // blank string
      mockDb({ company_settings: { data: null, error: { message: 'boom' } }, locations: { data: [], error: null } }), // query error
      mockDb({}),                                                                        // no rows at all
    ]) {
      const out = await getLocationBranding(db, 'loc1')
      expect(out.companyName).toBe('UN1T')
      expect(out.companyNameConfigured).toBe(false)
    }
    expect((await getLocationBranding(mockDb({}), null)).companyNameConfigured).toBe(false)
    expect((await getLocationBranding(null, 'loc1')).companyNameConfigured).toBe(false)
  })
})
