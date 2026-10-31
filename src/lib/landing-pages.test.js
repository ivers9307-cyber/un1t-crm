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

vi.mock('@/lib/permissions', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, hasPermissionForLocation: vi.fn(actual.hasPermissionForLocation) }
})

import {
  PAGE_PUBLISH_STATES, isPageVisible, isPageReachable, PAGE_COLUMNS, STUDIO_ROW_COLUMNS,
  loadPageBySlug, loadPageById, PageReadError, publicOrgIdForHost, studioParamToPublicPath,
  resolvePageStudio, locationIdForPublicPath, studioPublicPath, mergedBlocksFor, offerReady,
  canViewPage, canEditPage, studioTermsCopy,
  studioRowReadiness, pageBlocksToStore, mergedChrome, offerSummary, copiedContentBlocks, starterBlocks, pageWasLive,
} from './landing-pages.js'
import { DEFAULT_FUNNEL_TERMS_COPY } from '@/lib/un1t-online-funnel-copy'
import { hasPermissionForLocation } from '@/lib/permissions'
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

  it('locationIdForPublicPath: the studio page row at that slug, null when there is none (no fallback table)', async () => {
    const withPage = makeDb({ landing_pages: { single: { data: { primary_location_id: 'loc-s' }, error: null } } })
    expect(await locationIdForPublicPath(withPage, 'org-un1t', 'stillorgan')).toBe('loc-s')
    expect(withPage.calls[0].eq).toEqual([['organization_id', 'org-un1t'], ['kind', 'studio'], ['slug', 'stillorgan']])
    const none = makeDb({})
    expect(await locationIdForPublicPath(none, 'org-un1t', 'nowhere')).toBeNull()
    expect(none.calls.map((c) => c.table)).toEqual(['landing_pages'])
    const failed = makeDb({ landing_pages: { single: { data: null, error: { code: 'XX' } } } })
    await expect(locationIdForPublicPath(failed, 'org-un1t', 'stillorgan')).rejects.toThrow()
  })

  it('studioPublicPath: the studio page slug, null when the studio has no page (no fallback table)', async () => {
    const withPage = makeDb({ landing_pages: { single: { data: { slug: 'stillorgan' }, error: null } } })
    expect(await studioPublicPath(withPage, 'loc-s')).toBe('stillorgan')
    const none = makeDb({})
    expect(await studioPublicPath(none, 'loc-x')).toBeNull()
    expect(none.calls.map((c) => c.table)).toEqual(['landing_pages'])
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

  it('canViewPage: master, an org admin, or landing_page at the one studio / at any studio of the org (all studios)', () => {
    const one = { ...page, scope: 'one', primary_location_id: 'loc-s' }
    // A member with landing_page (a per-user override on a manager, whose default is off).
    const editor = (id, org = 'org-un1t') => ({
      role: 'manager', locations: [{ id, role: 'manager', organization_id: org }],
      assignmentsByLocation: { [id]: { role: 'manager', permissions: { landing_page: true } } },
    })
    // A coach: a studio member without landing_page.
    const coach = (id, org = 'org-un1t') => ({
      role: 'head_coach', locations: [{ id, role: 'head_coach', organization_id: org }],
      assignmentsByLocation: { [id]: { role: 'head_coach', permissions: {} } },
    })
    expect(canViewPage({ role: 'master' }, page)).toBe(true)
    expect(canViewPage({ orgAdminOrgIds: ['org-un1t'] }, page)).toBe(true)
    expect(canViewPage(editor('loc-s'), one)).toBe(true)
    expect(canViewPage(editor('loc-s'), page)).toBe(true)
    expect(canViewPage(editor('loc-x', 'org-other'), page)).toBe(false)
    expect(canViewPage(editor('loc-other'), one)).toBe(false)
    expect(canViewPage(coach('loc-s'), one)).toBe(false)
    expect(canViewPage(coach('loc-s'), page)).toBe(false)
    // landing_page at a studio of ANOTHER org does not open this org's all-studios page.
    const mixed = {
      role: 'manager',
      locations: [{ id: 'loc-x', role: 'manager', organization_id: 'org-other' }, { id: 'loc-s', role: 'head_coach', organization_id: 'org-un1t' }],
      assignmentsByLocation: {
        'loc-x': { role: 'manager', permissions: { landing_page: true } },
        'loc-s': { role: 'head_coach', permissions: {} },
      },
    }
    expect(canViewPage(mixed, page)).toBe(false)
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
    expect(canEditPage({ role: 'staff', locations: [], assignmentsByLocation: {} }, one)).toBe(false)
  })

  it('canEditPage: a master goes through the helper, so a studio with the landing_page feature off refuses them', () => {
    const one = { ...page, scope: 'one', primary_location_id: 'loc-s' }
    const master = { role: 'master' }
    hasPermissionForLocation.mockReturnValueOnce(true)
    expect(canEditPage(master, one)).toBe(true)
    expect(hasPermissionForLocation).toHaveBeenLastCalledWith(master, 'loc-s', 'landing_page')
    hasPermissionForLocation.mockReturnValueOnce(false)
    expect(canEditPage(master, one)).toBe(false)
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

  it('studioTermsCopy reads the studio page\'s chrome.un1t_terms by location (and nothing else); defaults on a miss, an error or a throw', async () => {
    const db = makeDb({ landing_pages: { single: { data: { chrome: { logo_url: 'x', un1t_terms: { terms_label: 'CUSTOM {studio_name}', waiver_link_label: '  ' } } }, error: null } } })
    const got = await studioTermsCopy(db, 'loc-h')
    expect(got).toEqual({ ...DEFAULT_FUNNEL_TERMS_COPY, terms_label: 'CUSTOM {studio_name}' })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]).toMatchObject({ table: 'landing_pages', select: 'chrome', eq: [['kind', 'studio'], ['primary_location_id', 'loc-h']] })
    // An empty un1t_terms (today's rows) and a page with no chrome are the defaults.
    expect(await studioTermsCopy(makeDb({ landing_pages: { single: { data: { chrome: { un1t_terms: {} } }, error: null } } }), 'loc-h')).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(await studioTermsCopy(makeDb({ landing_pages: { single: { data: { chrome: null }, error: null } } }), 'loc-h')).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(await studioTermsCopy(makeDb({}), 'loc-h')).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(await studioTermsCopy(makeDb({ landing_pages: { single: { data: null, error: { code: 'XX', message: 'secret' } } } }), 'loc-h')).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(await studioTermsCopy({ from: () => { throw new Error('net') } }, 'loc-h')).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
    expect(await studioTermsCopy(makeDb({}), null)).toEqual(DEFAULT_FUNNEL_TERMS_COPY)
  })
})

describe('landing-pages: the pages API helpers', () => {
  // A studio row with the STUDIO_ROW_COLUMNS embed.
  const row = (over = {}, loc = {}) => ({
    location_id: 'loc-s', enabled: true, sort_order: 0, attribution: {},
    offer: { membership_id: 'm', plan_code: 'p', price_cents: 3900 },
    locations: { id: 'loc-s', name: 'Stillorgan', membership_source: 'glofox', settings: {}, ...loc },
    ...over,
  })
  const studioPage = (slug) => ({ landing_pages: { single: { data: { slug }, error: null } } })

  it('studioRowReadiness: ready, needs_plan, no_platform; a page with no offer is ready', async () => {
    const db = makeDb(studioPage('stillorgan'))
    expect(await studioRowReadiness(db, { page, row: row() })).toEqual({ ready: true, reason: 'ready' })
    expect(await studioRowReadiness(db, { page, row: row({ offer: {} }) })).toEqual({ ready: false, reason: 'needs_plan' })
    expect(await studioRowReadiness(db, { page, row: row({}, { membership_source: 'none' }) })).toEqual({ ready: false, reason: 'no_platform' })
    expect(await studioRowReadiness(makeDb({}), { page, row: row() })).toEqual({ ready: false, reason: 'no_platform' }) // no public path
    expect(await studioRowReadiness(makeDb({}), { page: { ...page, offer_type: 'none' }, row: row() })).toEqual({ ready: true, reason: 'ready' })
    // A caller that already read the path passes it and no read happens.
    const quiet = makeDb({})
    expect(await studioRowReadiness(quiet, { page, row: row(), publicPath: 'stillorgan' })).toEqual({ ready: true, reason: 'ready' })
    expect(quiet.calls).toEqual([])
  })

  it('studioRowReadiness: a un1t.online paid trial reads the product; writes off is no_platform; a failed read throws', async () => {
    const hatch = (offer, settings = { un1t_online: { writes_enabled: true } }) =>
      row({ location_id: 'loc-h', offer }, { id: 'loc-h', membership_source: 'un1t_online', settings })
    const product = { un1t_id: 'u1', status: 'active', type: 'one_time', price_cents: 3900, currency: 'eur', title: 'T' }
    const tables = (p) => ({ landing_pages: { single: { data: { slug: 'hatch-street' }, error: null } }, un1t_products: { single: p } })
    expect(await studioRowReadiness(makeDb(tables({ data: product, error: null })), { page, row: hatch({ un1t_product_id: 'u1' }) }))
      .toEqual({ ready: true, reason: 'ready' })
    expect(await studioRowReadiness(makeDb(tables({ data: null, error: null })), { page, row: hatch({ un1t_product_id: 'u1' }) }))
      .toEqual({ ready: false, reason: 'needs_plan' })
    expect(await studioRowReadiness(makeDb(tables({ data: product, error: null })), { page, row: hatch({ un1t_product_id: 'u1' }, {}) }))
      .toEqual({ ready: false, reason: 'no_platform' })
    await expect(studioRowReadiness(makeDb(tables({ data: null, error: { message: 'boom' } })), { page, row: hatch({ un1t_product_id: 'u1' }) }))
      .rejects.toBeInstanceOf(PageReadError)
    const badPath = makeDb({ landing_pages: { single: { data: null, error: { message: 'boom' } } } })
    await expect(studioRowReadiness(badPath, { page, row: row() })).rejects.toBeInstanceOf(PageReadError)
  })

  it('pageBlocksToStore: the offer block first on a campaign page, anywhere on a studio page; never a studio half', () => {
    const offer = { id: 'o', type: 'paid_trial', heading: 'H', plan_code: 'p', tag: 't' }
    expect(pageBlocksToStore(page, [offer, { id: 'h', type: 'hero' }])).toEqual({ ok: true, blocks: [{ id: 'o', type: 'paid_trial', heading: 'H' }, { id: 'h', type: 'hero' }] })
    expect(pageBlocksToStore(page, [{ id: 'h', type: 'hero' }, offer])).toEqual({ ok: false, error: 'offer_block_required' })
    expect(pageBlocksToStore({ ...page, kind: 'studio' }, [{ id: 'h', type: 'hero' }, offer]).ok).toBe(true)
    expect(pageBlocksToStore({ ...page, offer_type: 'none' }, [{ id: 'h', type: 'hero' }]).ok).toBe(true)
  })

  it('mergedChrome keeps the stored was_live and merges un1t_terms key by key', () => {
    expect(mergedChrome({ was_live: true, tone: 'dark', un1t_terms: { terms_label: 'a', terms_link_label: 'b' } }, { tone: 'light', was_live: false, un1t_terms: { terms_label: 'c' } }))
      .toEqual({ was_live: true, tone: 'light', un1t_terms: { terms_label: 'c', terms_link_label: 'b' } })
    expect(mergedChrome({}, { was_live: true })).toEqual({})
    expect(pageWasLive({ chrome: { was_live: true }, publish_state: 'draft' })).toBe(true)
    expect(pageWasLive({ chrome: {}, publish_state: 'live' })).toBe(true)
    expect(pageWasLive({ chrome: {}, publish_state: 'draft' })).toBe(false)
  })

  it('offerSummary, starterBlocks, copiedContentBlocks', () => {
    const edit = { canEdit: true }
    expect(offerSummary(page, [], edit)).toBe('Paid trial, per studio')
    const one = { ...page, scope: 'one', primary_location_id: 'loc-s' }
    const rows = [{ location_id: 'loc-s', offer: { product_name: '14 Day Reset' } }]
    expect(offerSummary(one, rows, edit)).toBe('Paid trial: 14 Day Reset')
    expect(offerSummary(one, [], edit)).toBe('Paid trial')
    expect(offerSummary({ ...page, offer_type: 'none' }, [], edit)).toBe('No offer')
    // A viewer gets the type label alone: never the studio's plan, product or keywords.
    expect(offerSummary(one, rows)).toBe('Paid trial')
    expect(offerSummary({ ...one, offer_type: 'one_class' }, [{ location_id: 'loc-s', offer: { class_keywords: '50+' } }])).toBe('One class')
    expect(offerSummary({ ...one, offer_type: 'one_class' }, [{ location_id: 'loc-s', offer: { class_keywords: '50+' } }], edit)).toBe('One class: 50+')
    expect(offerSummary(page, [])).toBe('Paid trial')

    expect(starterBlocks('none', 'UN1T').map((b) => b.type)).toEqual(['hero'])
    const [corp] = starterBlocks('promo_credits', 'UN1T')
    expect(corp.type).toBe('corp_promo')
    expect(corp).not.toHaveProperty('promo_key')

    const copied = copiedContentBlocks([{ id: 'o', type: 'paid_trial' }, { id: 'g', type: 'gallery', items: [{ url: 'https://x/a.jpg' }] }])
    expect(copied).toHaveLength(1)
    expect(copied[0]).toMatchObject({ type: 'gallery', items: [{ url: 'https://x/a.jpg' }] })
    expect(copied[0].id).not.toBe('g')
  })
})
