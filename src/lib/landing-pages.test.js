// PAGES.1 — the readers over landing_pages / landing_page_studios: load by
// slug, the studio half resolved from a ?studio= value, the offer block merged
// with its studio row, who may see and edit a page, and which organisation a
// public host belongs to.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantOrgId: vi.fn(async () => null) }))
vi.mock('@/lib/brands', () => ({
  UN1T_GROUP_ORG_ID: 'org-un1t',
  resolveBrand: vi.fn(() => null),
}))

import {
  PAGE_PUBLISH_STATES, isPageVisible, isPageReachable, PAGE_COLUMNS, STUDIO_ROW_COLUMNS,
  loadPageBySlug, loadPageById, PageReadError, publicOrgIdForHost, studioParamToPublicPath,
  resolvePageStudio, locationIdForPublicPath, studioPublicPath, mergedBlocksFor, offerReady,
  canViewPage, canEditPage,
} from './landing-pages.js'
import { resolveBrand } from '@/lib/brands'
import { resolveTenantOrgId } from '@/lib/tenant-domains-edge'

const page = {
  id: 'p1', organization_id: 'org-un1t', slug: '50plus', scope: 'all', kind: 'campaign',
  primary_location_id: null, offer_type: 'paid_trial',
  blocks: [{ id: 'o', type: 'paid_trial', heading: 'H' }, { id: 'h', type: 'hero' }],
}
const studios = [
  { location_id: 'loc-s', enabled: true, sort_order: 0, offer: { membership_id: 'm', plan_code: 'p', price_cents: 3900 }, attribution: {} },
  { location_id: 'loc-h', enabled: false, sort_order: 1, offer: {}, attribution: {} },
]

// A chainable fake: each from(table) returns a builder that records its calls
// and resolves from `tables[table]`.
function makeDb(tables) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const rec = { table, eq: [], order: null, select: null }
      calls.push(rec)
      const q = {
        select(cols) { rec.select = cols; return q },
        eq(col, val) { rec.eq.push([col, val]); return q },
        order(col) { rec.order = col; return q },
        limit() { return q },
        maybeSingle: async () => tables[table]?.single ?? { data: null, error: null },
        then(resolve, reject) { return Promise.resolve(tables[table]?.list ?? { data: [], error: null }).then(resolve, reject) },
      }
      return q
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveBrand.mockReturnValue(null)
  resolveTenantOrgId.mockResolvedValue(null)
})

describe('landing-pages', () => {
  it('publish states: only live is visible; live, coming_soon and retired are reachable', () => {
    expect(PAGE_PUBLISH_STATES).toEqual(['draft', 'live', 'coming_soon', 'retired'])
    expect(isPageVisible('live')).toBe(true)
    expect(isPageVisible('coming_soon')).toBe(false)
    expect(['draft', 'live', 'coming_soon', 'retired'].map(isPageReachable)).toEqual([false, true, true, true])
  })

  it('loadPageBySlug returns the page with its studio rows ordered, null on a miss, throws on a read error', async () => {
    const db = makeDb({
      landing_pages: { single: { data: page, error: null } },
      landing_page_studios: { list: { data: studios, error: null } },
    })
    const got = await loadPageBySlug(db, { orgId: 'org-un1t', slug: '50plus' })
    expect(got.page).toBe(page)
    expect(got.studios).toBe(studios)
    expect(db.calls[0]).toMatchObject({ table: 'landing_pages', select: PAGE_COLUMNS })
    expect(db.calls[0].eq).toEqual([['organization_id', 'org-un1t'], ['slug', '50plus']])
    expect(db.calls[1]).toMatchObject({ table: 'landing_page_studios', select: STUDIO_ROW_COLUMNS, order: 'sort_order' })
    expect(db.calls[1].eq).toEqual([['page_id', 'p1']])

    const miss = makeDb({ landing_pages: { single: { data: null, error: null } } })
    expect(await loadPageBySlug(miss, { orgId: 'org-un1t', slug: 'nope' })).toBeNull()

    const bad = makeDb({ landing_pages: { single: { data: null, error: { message: 'boom' } } } })
    await expect(loadPageBySlug(bad, { orgId: 'org-un1t', slug: 'x' })).rejects.toBeInstanceOf(PageReadError)

    const badStudios = makeDb({
      landing_pages: { single: { data: page, error: null } },
      landing_page_studios: { list: { data: null, error: { message: 'boom' } } },
    })
    await expect(loadPageBySlug(badStudios, { orgId: 'org-un1t', slug: 'x' })).rejects.toBeInstanceOf(PageReadError)
  })

  it('loadPageById reads by id', async () => {
    const db = makeDb({
      landing_pages: { single: { data: page, error: null } },
      landing_page_studios: { list: { data: studios, error: null } },
    })
    const got = await loadPageById(db, 'p1')
    expect(got.page.id).toBe('p1')
    expect(db.calls[0].eq).toEqual([['id', 'p1']])
  })

  it('resolvePageStudio: scope one → the primary row and an empty picker', () => {
    const one = { ...page, scope: 'one', primary_location_id: 'loc-s' }
    const r = resolvePageStudio({ page: one, studios, studioLocationId: null })
    expect(r.studio.location_id).toBe('loc-s')
    expect(r.picker).toEqual([])
    const missing = resolvePageStudio({ page: { ...one, primary_location_id: 'loc-x' }, studios, studioLocationId: null })
    expect(missing.studio).toBeNull()
  })

  it('resolvePageStudio ignores a disabled studio and lists only enabled rows in the picker', () => {
    const r = resolvePageStudio({ page, studios, studioLocationId: 'loc-h' })
    expect(r.studio).toBeNull()
    expect(r.picker.map((x) => x.location_id)).toEqual(['loc-s'])
    expect(resolvePageStudio({ page, studios, studioLocationId: 'loc-s' }).studio.location_id).toBe('loc-s')
    expect(resolvePageStudio({ page, studios, studioLocationId: 'loc-unknown' }).studio).toBeNull()
  })

  it('studioParamToPublicPath maps hatch → hatch-street and refuses junk', () => {
    expect(studioParamToPublicPath('hatch')).toBe('hatch-street')
    expect(studioParamToPublicPath('stillorgan')).toBe('stillorgan')
    expect(studioParamToPublicPath('Hatch-Street')).toBe('hatch-street')
    expect(studioParamToPublicPath('a b!')).toBeNull()
    expect(studioParamToPublicPath(null)).toBeNull()
  })

  it('locationIdForPublicPath: the studio page row wins, then landing_page_settings', async () => {
    const withPage = makeDb({ landing_pages: { single: { data: { primary_location_id: 'loc-s' }, error: null } } })
    expect(await locationIdForPublicPath(withPage, 'org-un1t', 'stillorgan')).toBe('loc-s')
    expect(withPage.calls[0].eq).toEqual([['organization_id', 'org-un1t'], ['kind', 'studio'], ['slug', 'stillorgan']])
    const legacy = makeDb({
      landing_pages: { single: { data: null, error: null } },
      landing_page_settings: { single: { data: { location_id: 'loc-legacy' }, error: null } },
    })
    expect(await locationIdForPublicPath(legacy, 'org-un1t', 'stillorgan')).toBe('loc-legacy')
    expect(legacy.calls[1].eq).toEqual([['public_path', 'stillorgan']])
    const none = makeDb({})
    expect(await locationIdForPublicPath(none, 'org-un1t', 'nowhere')).toBeNull()
  })

  it('studioPublicPath: the studio page slug, then landing_page_settings', async () => {
    const withPage = makeDb({ landing_pages: { single: { data: { slug: 'stillorgan' }, error: null } } })
    expect(await studioPublicPath(withPage, 'loc-s')).toBe('stillorgan')
    const legacy = makeDb({
      landing_pages: { single: { data: null, error: null } },
      landing_page_settings: { single: { data: { public_path: 'hatch-street' }, error: null } },
    })
    expect(await studioPublicPath(legacy, 'loc-h')).toBe('hatch-street')
    expect(await studioPublicPath(makeDb({}), 'loc-x')).toBeNull()
  })

  it('mergedBlocksFor merges the studio half onto the offer block only', () => {
    const out = mergedBlocksFor({ page, studio: studios[0] })
    expect(out[0].plan_code).toBe('p')
    expect(out[0].heading).toBe('H')
    expect(out[1]).toEqual({ id: 'h', type: 'hero' })
    expect(mergedBlocksFor({ page, studio: null })[0]).toEqual({ id: 'o', type: 'paid_trial', heading: 'H' })
  })

  it('mergedBlocksFor re-injects the page slug as `campaign` on a campaign_funnel block', () => {
    const camp = { ...page, slug: '50plus', offer_type: 'one_class', blocks: [{ id: 'c', type: 'campaign_funnel' }, { id: 'h', type: 'hero' }] }
    const out = mergedBlocksFor({ page: camp, studio: { offer: { class_keywords: '50+' }, attribution: {} } })
    expect(out[0]).toMatchObject({ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' })
    expect(out[1]).not.toHaveProperty('campaign')
  })

  it('offerReady judges the merged offer block', () => {
    expect(offerReady({ page: { ...page, offer_type: 'none' }, studio: studios[0], landingPath: 'stillorgan' })).toBe(false)
    expect(offerReady({ page, studio: studios[0], landingPath: 'stillorgan' })).toBe(true)
    expect(offerReady({ page, studio: { offer: {}, attribution: {} }, landingPath: 'stillorgan' })).toBe(false)
  })

  it('canViewPage: master, an org admin, or a member of the one studio', () => {
    const one = { ...page, scope: 'one', primary_location_id: 'loc-s' }
    expect(canViewPage({ role: 'master' }, page)).toBe(true)
    expect(canViewPage({ orgAdminOrgIds: ['org-un1t'] }, page)).toBe(true)
    expect(canViewPage({ locations: [{ id: 'loc-s' }] }, one)).toBe(true)
    expect(canViewPage({ locations: [{ id: 'loc-s' }] }, page)).toBe(false)
    expect(canViewPage({ locations: [{ id: 'loc-other' }] }, one)).toBe(false)
    expect(canViewPage(null, one)).toBe(false)
  })

  it('canEditPage: scope one needs landing_page at the studio; scope all needs an org admin; a studio manager is refused on an all-studios page', () => {
    const one = { ...page, scope: 'one', primary_location_id: 'loc-s' }
    const manager = {
      role: 'manager', locations: [{ id: 'loc-s', role: 'manager' }],
      assignmentsByLocation: { 'loc-s': { role: 'owner', permissions: {} } },
    }
    expect(canEditPage(manager, one)).toBe(true)
    expect(canEditPage(manager, page)).toBe(false)
    expect(canEditPage({ orgAdminOrgIds: ['org-un1t'] }, page)).toBe(true)
    expect(canEditPage({ role: 'master' }, page)).toBe(true)
    expect(canEditPage({ role: 'master' }, one)).toBe(true)
    expect(canEditPage({ role: 'staff', locations: [], assignmentsByLocation: {} }, one)).toBe(false)
  })

  it('publicOrgIdForHost: un1tdublin.com → UN1T Group; a tenant host → its org; the CRM host → UN1T Group', async () => {
    resolveBrand.mockReturnValueOnce({ organizationId: 'org-un1t' })
    expect(await publicOrgIdForHost('un1tdublin.com')).toBe('org-un1t')
    expect(resolveTenantOrgId).not.toHaveBeenCalled()

    resolveTenantOrgId.mockResolvedValueOnce('org-tenant')
    expect(await publicOrgIdForHost('studio.example.com')).toBe('org-tenant')

    expect(await publicOrgIdForHost('crm.un1tdublin.com')).toBe('org-un1t')
    expect(await publicOrgIdForHost(null)).toBe('org-un1t')
    expect(await publicOrgIdForHost('')).toBe('org-un1t')
  })
})
