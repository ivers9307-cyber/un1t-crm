import { describe, it, expect } from 'vitest'
import { getLocationBranding, getOrgBrandName, getOrgCustomerBranding } from './location-branding.js'
import { makeFakeDb } from './api-auth.test-helpers.js'

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
        in(col, vals) { filters.push([col, (v) => vals.includes(v)]); return b },
        order(col) { orderBy = col; return b },
        limit(n) { cap = n; return b },
        then(resolve, reject) {
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] }).then(resolve, reject)
          let out = (rows[table] || []).filter((r) => filters.every(([c, v]) => (typeof v === 'function' ? v(r[c]) : r[c] === v)))
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
      companyName: 'CCF Autos', shortName: 'CCF Autos', locationName: 'Gym A North', companyNameConfigured: true, logoUrl: 'l.png', faviconUrl: 'f.ico',
    })
  })

  it('a fully-configured location wins over org defaults (no inheritance)', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'Stillorgan', logo_url: 'loc.png', favicon_url: 'loc.ico' }],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'UN1T Group', logo_url: 'org.png', favicon_url: 'org.ico' }],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'Stillorgan', shortName: 'Stillorgan', locationName: 'Gym A North', companyNameConfigured: true, logoUrl: 'loc.png', faviconUrl: 'loc.ico',
    })
  })

  it('inherits the org brand when the location has no row', async () => {
    const db = fakeDb({
      company_settings: [],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'CCF Autos', logo_url: 'org.png', favicon_url: 'org.ico' }],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'CCF Autos', shortName: 'CCF Autos', locationName: 'Gym A North', companyNameConfigured: true, logoUrl: 'org.png', faviconUrl: 'org.ico',
    })
  })

  it('merges per field — location name kept, org fills the missing logo/favicon', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'Stillorgan', logo_url: null, favicon_url: null }],
      locations: [LOC],
      org_settings: [{ organization_id: 'org1', company_name: 'UN1T Group', logo_url: 'org.png', favicon_url: 'org.ico' }],
    })
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'Stillorgan', shortName: 'Stillorgan', locationName: 'Gym A North', companyNameConfigured: true, logoUrl: 'org.png', faviconUrl: 'org.ico',
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
    expect(b).toEqual({ companyName: 'Gym A', shortName: 'Gym A', locationName: 'Gym A North', companyNameConfigured: true, logoUrl: 'l.png', faviconUrl: 'f.ico' })
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

  it('W1.S3 — locationName is the studio\'s own label even when the brand is configured', async () => {
    const db = fakeDb({
      company_settings: [{ location_id: 'loc1', company_name: 'Gym A', logo_url: null, favicon_url: null }],
      locations: [LOC],
      org_settings: [],
    })
    const b = await getLocationBranding(db, 'loc1')
    expect(b.companyName).toBe('Gym A')
    expect(b.locationName).toBe('Gym A North')
    const none = await getLocationBranding(null, 'loc1')
    expect(none.locationName).toBe('')
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
      companyName: '', shortName: '', locationName: '', companyNameConfigured: false, logoUrl: null, faviconUrl: null,
    })
  })

  it('W1.B1 — a query error on company_settings still resolves the org and location tiers', async () => {
    const db = fakeDb(
      { locations: [LOC], org_settings: [{ organization_id: 'org1', company_name: 'Gym A' }] },
      { errors: { company_settings: { message: 'boom' } } },
    )
    expect(await getLocationBranding(db, 'loc1')).toEqual({
      companyName: 'Gym A', shortName: 'Gym A', locationName: 'Gym A North', companyNameConfigured: true, logoUrl: null, faviconUrl: null,
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

// W1.L4 — the ORGANISATION's customer-facing brand for a surface that knows
// the request's org (tenant host) but no location: the anonymous login
// screen, the <title>/OG site name, the favicon. Per field: org_settings →
// the earliest ACTIVE location's company_settings in that org → (name only)
// getOrgBrandName's location-name floor → '' / null. Uses makeFakeDb because
// the resolver's `.in()` is not in this file's older fake.
describe('getOrgCustomerBranding (W1.L4)', () => {
  const ORG_A = 'org-a'
  const ORG_B = 'org-b'
  const base = () => ({
    organizations: [
      { id: ORG_A, slug: 'gym-a', master_location_id: null },
      { id: ORG_B, slug: 'gym-b', master_location_id: null },
    ],
    locations: [
      { id: 'loc-a1', name: 'Gym A North', organization_id: ORG_A, active: true, created_at: '2026-01-01' },
      { id: 'loc-a2', name: 'Gym A South', organization_id: ORG_A, active: true, created_at: '2026-02-01' },
      { id: 'loc-b1', name: 'Gym B', organization_id: ORG_B, active: true, created_at: '2026-01-15' },
    ],
    org_settings: [],
    company_settings: [],
  })

  it('org_settings wins per field', async () => {
    const t = base()
    t.org_settings = [{ organization_id: ORG_A, company_name: 'Gym A', logo_url: 'org.png', favicon_url: 'org.ico' }]
    t.company_settings = [{ location_id: 'loc-a1', company_name: 'North', logo_url: 'n.png', favicon_url: 'n.ico' }]
    expect(await getOrgCustomerBranding(makeFakeDb(t), ORG_A)).toEqual({ companyName: 'Gym A', logoUrl: 'org.png', faviconUrl: 'org.ico' })
  })

  it('fills a missing field from the earliest active location\'s company_settings in THAT org', async () => {
    const t = base()
    t.org_settings = [{ organization_id: ORG_A, company_name: 'Gym A', logo_url: null, favicon_url: null }]
    t.company_settings = [
      { location_id: 'loc-a2', company_name: 'South', logo_url: 's.png', favicon_url: 's.ico' },
      { location_id: 'loc-a1', company_name: 'North', logo_url: null, favicon_url: 'n.ico' },
      { location_id: 'loc-b1', company_name: 'Gym B', logo_url: 'b.png', favicon_url: 'b.ico' },
    ]
    expect(await getOrgCustomerBranding(makeFakeDb(t), ORG_A)).toEqual({ companyName: 'Gym A', logoUrl: 's.png', faviconUrl: 'n.ico' })
  })

  it('another tenant\'s company_settings row never fills this org\'s brand', async () => {
    const t = base()
    t.company_settings = [{ location_id: 'loc-b1', company_name: 'Gym B', logo_url: 'b.png', favicon_url: 'b.ico' }]
    const a = await getOrgCustomerBranding(makeFakeDb(t), ORG_A)
    expect(a.logoUrl).toBe(null)
    expect(a.faviconUrl).toBe(null)
    expect(a.companyName).not.toBe('Gym B')
  })

  it('the name floors on the location-name chain (getOrgBrandName), never a literal', async () => {
    const t = base()
    expect((await getOrgCustomerBranding(makeFakeDb(t), ORG_A)).companyName).toBe('Gym A North')
    const t2 = base()
    t2.company_settings = [{ location_id: 'loc-a2', company_name: 'Gym A South Configured', logo_url: null, favicon_url: null }]
    expect((await getOrgCustomerBranding(makeFakeDb(t2), ORG_A)).companyName).toBe('Gym A South Configured')
  })

  // makeFakeDb's .order() is a no-op, so "earliest ACTIVE location" needs
  // this file's SORTING fake: locations seeded newest-first, an inactive one
  // oldest of all, and the answer must still be the oldest ACTIVE studio's.
  it('"earliest active location" really is by created_at, skipping inactive studios', async () => {
    const db = fakeDb({
      org_settings: [],
      organizations: [{ id: ORG_A, master_location_id: null }],
      locations: [
        { id: 'loc-new', name: 'Newest', organization_id: ORG_A, active: true, created_at: '2026-03-01' },
        { id: 'loc-mid', name: 'Middle', organization_id: ORG_A, active: true, created_at: '2026-02-01' },
        { id: 'loc-old', name: 'Oldest', organization_id: ORG_A, active: true, created_at: '2026-01-15' },
        { id: 'loc-dead', name: 'Closed', organization_id: ORG_A, active: false, created_at: '2026-01-01' },
      ],
      company_settings: [
        { location_id: 'loc-new', company_name: 'Newest Brand', logo_url: 'new.png', favicon_url: 'new.ico' },
        { location_id: 'loc-old', company_name: 'Oldest Brand', logo_url: null, favicon_url: 'old.ico' },
        { location_id: 'loc-dead', company_name: 'Closed Brand', logo_url: 'dead.png', favicon_url: 'dead.ico' },
      ],
    })
    // name + favicon from the oldest active studio; logo falls through to the next one that has one.
    expect(await getOrgCustomerBranding(db, ORG_A)).toEqual({ companyName: 'Oldest Brand', logoUrl: 'new.png', faviconUrl: 'old.ico' })
  })

  it('is empty with no db / no org, and never throws', async () => {
    const EMPTY = { companyName: '', logoUrl: null, faviconUrl: null }
    expect(await getOrgCustomerBranding(null, ORG_A)).toEqual(EMPTY)
    expect(await getOrgCustomerBranding(makeFakeDb(base()), null)).toEqual(EMPTY)
    expect(await getOrgCustomerBranding({ from() { throw new Error('x') } }, ORG_A)).toEqual(EMPTY)
  })
})
