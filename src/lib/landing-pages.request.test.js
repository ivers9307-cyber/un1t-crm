// PAGES.1 — resolvePublicPageRequest: which page, which studio and which
// attribution a public API request is about. The page row decides every one of
// them; the request only names the page and (on an all-studios page) the
// studio. A one-studio page never answers for another studio (Review Focus 4).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantOrgId: vi.fn(async () => null) }))
vi.mock('@/lib/brands', () => ({
  UN1T_GROUP_ORG_ID: 'org-un1t',
  resolveBrand: vi.fn(() => null),
}))

import { resolvePublicPageRequest } from './landing-pages.js'

const ONE = {
  id: 'p-50', organization_id: 'org-un1t', slug: '50plus', kind: 'campaign', scope: 'one',
  primary_location_id: 'loc-s', offer_type: 'one_class', publish_state: 'live',
  blocks: [{ id: 'cf', type: 'campaign_funnel', heading: 'Strong at 50' }, { id: 'h', type: 'hero' }],
}
const ALL = {
  id: 'p-trial', organization_id: 'org-un1t', slug: 'trial', kind: 'campaign', scope: 'all',
  primary_location_id: null, offer_type: 'paid_trial', publish_state: 'live',
  blocks: [{ id: 'pt', type: 'paid_trial', heading: 'Try us' }],
}
const ROW_S = { page_id: 'p-50', location_id: 'loc-s', enabled: true, sort_order: 0, offer: { class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }, attribution: { tag: 'stillorgan-50plus', lead_source: 'meta_50plus' } }
const TRIAL_S = { page_id: 'p-trial', location_id: 'loc-s', enabled: true, sort_order: 0, offer: { membership_id: 'm', plan_code: 'p', price_cents: 3900 }, attribution: {} }
const TRIAL_H = { page_id: 'p-trial', location_id: 'loc-h', enabled: false, sort_order: 1, offer: { un1t_product_id: 'u1' }, attribution: { tag: '', lead_source: 'meta_hatch_trial', event_source_url: '' } }
const TRIAL_H_ON = { ...TRIAL_H, enabled: true }

// Studio pages: the public path <-> location map.
const PATHS = { stillorgan: 'loc-s', 'hatch-street': 'loc-h' }

// A fake that answers each query from what it filtered on.
function makeDb({ pages = {}, studios = {}, legacy = null, failStudios = false } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const eq = {}
      calls.push({ table, eq })
      const q = {
        select() { return q },
        eq(col, val) { eq[col] = val; return q },
        order() { return q },
        maybeSingle: async () => {
          if (table === 'landing_pages' && eq.kind === 'studio' && eq.slug) {
            return { data: PATHS[eq.slug] ? { primary_location_id: PATHS[eq.slug] } : null, error: null }
          }
          if (table === 'landing_pages' && eq.kind === 'studio' && eq.primary_location_id) {
            const slug = Object.keys(PATHS).find((k) => PATHS[k] === eq.primary_location_id)
            return { data: slug ? { slug } : null, error: null }
          }
          if (table === 'landing_pages') return { data: pages[eq.slug] || null, error: null }
          if (table === 'landing_page_settings') return legacy || { data: null, error: null }
          return { data: null, error: null }
        },
        then(resolve, reject) {
          const out = table === 'landing_page_studios'
            ? (failStudios ? { data: null, error: { code: 'XX' } } : { data: studios[eq.page_id] || [], error: null })
            : { data: [], error: null }
          return Promise.resolve(out).then(resolve, reject)
        },
      }
      return q
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('resolvePublicPageRequest', () => {
  it('a one-studio page ignores studio when it names the primary and refuses another studio with not_found', async () => {
    const db = makeDb({ pages: { '50plus': ONE }, studios: { 'p-50': [ROW_S] } })
    const bare = await resolvePublicPageRequest(db, { hostname: 'www.un1tdublin.com', page: '50plus' })
    expect(bare).toMatchObject({ ok: true, pageId: 'p-50', locationId: 'loc-s', publicPath: 'stillorgan', studioRow: ROW_S })
    expect(bare.page.id).toBe('p-50')
    const merged = bare.blocks.find((b) => b.type === 'campaign_funnel')
    expect(merged).toMatchObject({ class_keywords: '50+', trial_membership_id: 'm', campaign: '50plus' })
    expect(bare.attribution).toEqual({ tag: 'stillorgan-50plus', lead_source: 'meta_50plus' })

    const named = await resolvePublicPageRequest(db, { hostname: 'www.un1tdublin.com', page: '50plus', studio: 'stillorgan' })
    expect(named).toMatchObject({ ok: true, locationId: 'loc-s' })

    expect(await resolvePublicPageRequest(db, { page: '50plus', studio: 'hatch-street' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolvePublicPageRequest(db, { page: '50plus', studio: 'hatch' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolvePublicPageRequest(db, { page: '50plus', studio: 'nowhere' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolvePublicPageRequest(db, { page: '50plus', studio: '!!' })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a one-studio page switched off at its studio is not_found', async () => {
    const db = makeDb({ pages: { '50plus': ONE }, studios: { 'p-50': [{ ...ROW_S, enabled: false }] } })
    expect(await resolvePublicPageRequest(db, { page: '50plus' })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('an all-studios page needs a studio: missing → studio_required; disabled → not_found; enabled → merged blocks + attribution with defaults filled', async () => {
    const off = makeDb({ pages: { trial: ALL }, studios: { 'p-trial': [TRIAL_S, TRIAL_H] } })
    expect(await resolvePublicPageRequest(off, { page: 'trial' })).toEqual({ ok: false, reason: 'studio_required' })
    expect(await resolvePublicPageRequest(off, { page: 'trial', studio: '' })).toEqual({ ok: false, reason: 'studio_required' })
    expect(await resolvePublicPageRequest(off, { page: 'trial', studio: 'hatch-street' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolvePublicPageRequest(off, { page: 'trial', studio: 'galway' })).toEqual({ ok: false, reason: 'not_found' })

    const on = makeDb({ pages: { trial: ALL }, studios: { 'p-trial': [TRIAL_S, TRIAL_H_ON] } })
    const hatch = await resolvePublicPageRequest(on, { page: 'trial', studio: 'hatch' })
    expect(hatch).toMatchObject({ ok: true, pageId: 'p-trial', locationId: 'loc-h', publicPath: 'hatch-street', studioRow: TRIAL_H_ON })
    expect(hatch.blocks[0]).toMatchObject({ type: 'paid_trial', heading: 'Try us', un1t_product_id: 'u1' })
    // The row's blank tag is no value: the default fills it; its lead source wins.
    expect(hatch.attribution).toEqual({ tag: 'hatch-street-trial', lead_source: 'meta_hatch_trial' })

    const still = await resolvePublicPageRequest(on, { page: 'trial', studio: 'stillorgan' })
    expect(still).toMatchObject({ ok: true, locationId: 'loc-s', publicPath: 'stillorgan' })
    expect(still.attribution).toEqual({ tag: 'stillorgan-trial', lead_source: 'meta_trial' })
  })

  it('a draft page is not_found; a retired page is not_found for the API', async () => {
    for (const publish_state of ['draft', 'retired', 'coming_soon']) {
      const db = makeDb({ pages: { '50plus': { ...ONE, publish_state } }, studios: { 'p-50': [ROW_S] } })
      expect(await resolvePublicPageRequest(db, { page: '50plus' })).toEqual({ ok: false, reason: 'not_found' })
    }
    const none = makeDb({})
    expect(await resolvePublicPageRequest(none, { page: 'nothing-here' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolvePublicPageRequest(none, { page: 'Not A Slug!' })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('reads the page in the host organisation', async () => {
    const db = makeDb({ pages: { '50plus': ONE }, studios: { 'p-50': [ROW_S] } })
    await resolvePublicPageRequest(db, { hostname: 'www.un1tdublin.com', page: '50plus' })
    const read = db.calls.find((c) => c.table === 'landing_pages' && c.eq.slug === '50plus')
    expect(read.eq.organization_id).toBe('org-un1t')
  })

  it('a failed read is unreadable, never a refusal', async () => {
    const db = makeDb({ pages: { '50plus': ONE }, failStudios: true })
    expect(await resolvePublicPageRequest(db, { page: '50plus' })).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('legacy: no page → landing_page_settings by path, pageId null', async () => {
    const db = makeDb({ legacy: { data: { location_id: 'loc-s', public_path: 'stillorgan', blocks: [{ type: 'class_funnel' }] }, error: null } })
    const r = await resolvePublicPageRequest(db, { legacyPath: ' Stillorgan ' })
    expect(r).toEqual({
      ok: true, pageId: null, page: null, studioRow: null, locationId: 'loc-s', publicPath: 'stillorgan',
      blocks: [{ type: 'class_funnel' }], attribution: null,
    })
    expect(db.calls).toEqual([{ table: 'landing_page_settings', eq: { public_path: 'stillorgan' } }])

    // No path defaults to stillorgan, as the routes always have.
    const dflt = makeDb({ legacy: { data: { location_id: 'loc-s', public_path: 'stillorgan', blocks: [] }, error: null } })
    expect((await resolvePublicPageRequest(dflt, {})).publicPath).toBe('stillorgan')
    expect(dflt.calls[0].eq).toEqual({ public_path: 'stillorgan' })

    expect(await resolvePublicPageRequest(makeDb({}), { legacyPath: 'galway' })).toEqual({ ok: false, reason: 'not_found' })
    expect(await resolvePublicPageRequest(makeDb({ legacy: { data: null, error: { code: 'XX' } } }), { legacyPath: 'stillorgan' }))
      .toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('pageRequestRefusal', () => {
  it('studio_required 400, unreadable 503, everything else 404 not_found', async () => {
    const { pageRequestRefusal } = await import('./landing-pages.js')
    expect(pageRequestRefusal('studio_required')).toEqual({ status: 400, body: { success: false, error: 'studio_required' } })
    expect(pageRequestRefusal('unreadable').status).toBe(503)
    expect(pageRequestRefusal('unreadable').body).toMatchObject({ success: false, code: 'unavailable' })
    expect(pageRequestRefusal('not_found')).toEqual({ status: 404, body: { success: false, error: 'not_found' } })
    expect(pageRequestRefusal('not_configured').status).toBe(404)
  })
})
