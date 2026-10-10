import { describe, it, expect } from 'vitest'
import { getLocationBranding, getOrgBrandName } from './location-branding.js'

// Table-aware supabase-builder fake. `rows` is keyed by table; `.eq()` pairs
// filter the rows, `.order()` sorts, `.limit()` caps, and the builder is a
// thenable so any chain can be awaited. The resolver runs its queries
// sequentially, so one builder per `from()` is enough.
function fakeDb(rows, { errors = {} } = {}) {
  return {
    from(table) {
      const filters = []
      let orderBy = null
      let cap = null
      const b = {
        select() { return b },
        eq(col, val) { filters.push([col, val]); return b },
        order(col) { orderBy = col; return b },
        limit(n) { cap = n; return b },
        then(resolve, reject) {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject)
          let out = (rows[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v))
          if (orderBy) out = [...out].sort((a, z) => String(a[orderBy] ?? '').localeCompare(String(z[orderBy] ?? '')))
          if (cap != null) out = out.slice(0, cap)
          return Promise.resolve({ data: out, error: null }).then(resolve, reject)
        },
      }
      return b
    },
  }
}

const LOC = { id: 'loc1', name: 'Gym A North', organization_id: 'org1' }

describe('getLocationBranding', () => {
  it('returns the configured company name + assets (location level)', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'CCF Autos', logo_url: 'l.png', favicon_url: 'f.ico' }],
      locations: [LOC],
      org_settings: [],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'CCF Autos', shortName: 'CCF Autos', companyNameConfigured: true, logoUrl: 'l.png', faviconUrl: 'f.ico',
    })
  })

  it('a fully-configured location wins over org defaults (no inheritance)', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'Stillorgan', logo_url: 'loc.png', favicon_url: 'loc.ico' }],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'UN1T Group', logo_url: 'org.png', favicon_url: 'org.ico' }],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'Stillorgan', shortName: 'Stillorgan', companyNameConfigured: true, logoUrl: 'loc.png', faviconUrl: 'loc.ico',
    })
  })

  it('inherits the org brand when the location has no row', async () => {
    const db = fakeDb({
      company_settings: [],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'CCF Autos', logo_url: 'org.png', favicon_url: 'org.ico' }],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'CCF Autos', shortName: 'CCF Autos', companyNameConfigured: true, logoUrl: 'org.png', faviconUrl: 'org.ico',
    })
  })

  it('merges per field — location name kept, org fills the missing logo/favicon', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'Stillorgan', logo_url: null, favicon_url: null }],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'UN1T Group', logo_url: 'org.png', favicon_url: 'org.ico' }],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'Stillorgan', shortName: 'Stillorgan', companyNameConfigured: true, logoUrl: 'org.png', faviconUrl: 'org.ico',
    })
  })

  it('W1.B1 — with no company_settings and no org_settings the brand is the location name', async () => {
    const db = fakeDb({ company_settings: [], org_settings: [], locations: [{ id: 'loc-1', name: 'Gym A North', organization_id: 'org-a' }] })
    const b = await getLocationBranding(db, 'loc-1')
    expect(b.companyName).toBe('Gym A North')
    expect(b.companyNameConfigured).toBe(false)
  })

  it('W1.B1 — company_settings beats org_settings beats locations.name, per field', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc-1', company_name: '', logo_url: 'l.png' }],
      org_settings: [{ organization_id: 'org-a', company_name: 'Gym A', favicon_url: 'f.ico' }],
      locations: [{ id: 'loc-1', name: 'Gym A North', organization_id: 'org-a' }],
    })
    const b = await getLocationBranding(db, 'loc-1')
    expect(b).toEqual({ companyName: 'Gym A', shortName: 'Gym A', companyNameConfigured: true, logoUrl: 'l.png', faviconUrl: 'f.ico' })
  })

  it('W1.B1 — shortName is org_settings.short_name when set, else the resolved brand', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc-1', company_name: 'UN1T Hatch Street' }],
      org_settings: [{ organization_id: 'org-a', company_name: 'UN1T Dublin', short_name: 'UN1T' }],
      locations: [{ id: 'loc-1', name: 'UN1T Hatch Street', organization_id: 'org-a' }],
    })
    expect((await getLocationBranding(db, 'loc-1')).shortName).toBe('UN1T')
  })

  it('W1.B1 — a location with no organisation still resolves its own name', async () => {
    const db = fakeDb({ company_settings: [], org_settings: [], locations: [{ id: 'loc-1', name: 'Solo Gym', organization_id: null }] })
    const b = await getLocationBranding(db, 'loc-1')
    expect(b.companyName).toBe('Solo Gym')
    expect(b.shortName).toBe('Solo Gym')
    expect(b.companyNameConfigured).toBe(false)
  })

  it('W1.B1 — a blank company_settings name and no org name fall through to the location name', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: '   ', logo_url: null, favicon_url: null }],
      locations: [LOC],
      org_settings: [],
    })
    const b = await getLocationBranding(db, 'loc1')
    expect(b.companyName).toBe('Gym A North')
    expect(b.companyNameConfigured).toBe(false)
  })

  it('W1.B1 — no db / no location / a thrown error yields an EMPTY name, never a literal', async () => {
    expect((await getLocationBranding(null, 'loc-1')).companyName).toBe('')
    expect((await getLocationBranding({ from() { throw new Error('x') } }, 'loc-1')).companyName).toBe('')
    expect(await getLocationBranding(fakeDb({}), null)).toEqual({
      companyName: '', shortName: '', companyNameConfigured: false, logoUrl: null, faviconUrl: null,
    })
  })

  it('W1.B1 — a query error on company_settings still resolves the org and location tiers', async () => {
    const db = fakeDb(
      { locations: [LOC], org_settings: [{ organization_id: 'org1', company_name: 'Gym A' }] },
      { errors: { company_settings: { message: 'boom' } } },
    )
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'Gym A', shortName: 'Gym A', companyNameConfigured: true, logoUrl: null, faviconUrl: null,
    })
  })

  it('W1.B1 — the module exports no DEFAULT_COMPANY_NAME', async () => {
    const mod = await import('./location-branding')
    expect(mod.DEFAULT_COMPANY_NAME).toBeUndefined()
  })
})

// LEGALENT.2 — companyNameConfigured separates "an operator named this
// business" from "nobody did". Since W1.B1 the unconfigured answer is the
// location's own name (a label, not a brand), so a caller making a CLAIM
// about a company — a contract countersignature, a party clause — reads
// this flag rather than the string; see src/lib/contracting-entity.js.
describe('getLocationBranding — companyNameConfigured', () => {
  it('is true when a location configured the name', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'CCF Autos', logo_url: 'l.png', favicon_url: 'f.ico' }],
      locations: [LOC],
    })
    expect((await getLocationBranding(db, 'loc1')).companyNameConfigured).toBe(true)
  })

  it('is true when the name is inherited from the org', async () => {
    const db = fakeDb({
      company_settings: [],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'CCF Autos', logo_url: null, favicon_url: null }],
    })
    const out = await getLocationBranding(db, 'loc1')
    expect(out.companyName).toBe('CCF Autos')
    expect(out.companyNameConfigured).toBe(true)
  })

  it('is FALSE whenever companyName is only the location label or empty', async () => {
    for (const db of [
      fakeDb({ locations: [LOC] }),                                                                     // nothing set anywhere
      fakeDb({ company_settings: [{ location_id: 'loc1', company_name: '   ' }], locations: [LOC] }),  // blank string
      fakeDb({ locations: [LOC] }, { errors: { company_settings: { message: 'boom' } } }),              // query error
      fakeDb({}),                                                                                       // no rows at all
    ]) {
      const out = await getLocationBranding(db, 'loc1')
      expect(out.companyName).not.toBe('UN1T')
      expect(out.companyNameConfigured).toBe(false)
    }
    expect((await getLocationBranding(fakeDb({}), null)).companyNameConfigured).toBe(false)
    expect((await getLocationBranding(null, 'loc1')).companyNameConfigured).toBe(false)
  })
})

// HOST-CONSENT.1 — the org-level brand name for copy that speaks for the
// whole organisation (the two-consent sentences on /h/[slug] and hosted-event
// registration). Reads org_settings first — never organizations.name, which
// is the ops tenant label. W1.B1: the chain continues to the master
// location's name, then the earliest active location's, then ''.
describe('getOrgBrandName', () => {
  it('returns the operator-configured org brand name', async () => {
    const db = fakeDb({ org_settings: [{ organization_id: 'org1', company_name: 'UN1T Dublin' }] })
    expect(await getOrgBrandName(db, 'org1')).toBe('UN1T Dublin')
  })

  it('W1.B1 — falls back to the master location name when the org has not set a name', async () => {
    const db = fakeDb({
      org_settings: [{ organization_id: 'org1', company_name: '   ' }],
      organizations: [{ id: 'org1', master_location_id: 'loc-m' }],
      locations: [
        { id: 'loc-m', name: 'Gym A Main', organization_id: 'org1', active: true, created_at: '2026-02-01' },
        { id: 'loc-2', name: 'Gym A Old', organization_id: 'org1', active: true, created_at: '2026-01-01' },
      ],
    })
    expect(await getOrgBrandName(db, 'org1')).toBe('Gym A Main')
  })

  it('W1.B1 — then the earliest ACTIVE location in the org', async () => {
    const db = fakeDb({
      org_settings: [],
      organizations: [{ id: 'org1', master_location_id: null }],
      locations: [
        { id: 'loc-3', name: 'Gym A Closed', organization_id: 'org1', active: false, created_at: '2025-01-01' },
        { id: 'loc-2', name: 'Gym A Second', organization_id: 'org1', active: true, created_at: '2026-03-01' },
        { id: 'loc-1', name: 'Gym A First', organization_id: 'org1', active: true, created_at: '2026-01-01' },
        { id: 'loc-x', name: 'Other Org', organization_id: 'org2', active: true, created_at: '2024-01-01' },
      ],
    })
    expect(await getOrgBrandName(db, 'org1')).toBe('Gym A First')
  })

  it('W1.B1 — is EMPTY, never a literal, when no row answers or a query errors', async () => {
    expect(await getOrgBrandName(fakeDb({}), 'org1')).toBe('')
    expect(await getOrgBrandName(fakeDb({}, { errors: { org_settings: { message: 'boom' } } }), 'org1')).toBe('')
  })

  it('W1.B1 — is empty when db or organizationId is missing, without querying', async () => {
    expect(await getOrgBrandName(null, 'org1')).toBe('')
    expect(await getOrgBrandName({ from() { throw new Error('should not query') } }, null)).toBe('')
  })

  it('never throws — swallows a thrown query and returns empty', async () => {
    const db = { from() { throw new Error('boom') } }
    expect(await getOrgBrandName(db, 'org1')).toBe('')
  })
})
