// PAGES.1 — copySourceForRequest: the confirmation copy of a request comes from
// the page the request came from (merged with that page's studio row), else
// from the studio's own kind='studio' page (Task 23). It never throws.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantOrgId: vi.fn(async () => null) }))
vi.mock('@/lib/brands', () => ({ UN1T_GROUP_ORG_ID: 'org-un1t', resolveBrand: vi.fn(() => null) }))

import { copySourceForRequest, studioPageBlocksFor } from './landing-pages.js'
import { logWarn } from '@/lib/log'

const PAGE = {
  id: 'p-50', organization_id: 'org-un1t', slug: '50plus', kind: 'campaign', scope: 'one',
  primary_location_id: 'loc-s', offer_type: 'one_class', publish_state: 'live',
  blocks: [{ id: 'cf', type: 'campaign_funnel', heading: 'Strong at 50' }, { id: 'cl', type: 'class_funnel', confirm_subject: 'See you at 50+' }],
}
const ROW = { page_id: 'p-50', location_id: 'loc-s', enabled: true, sort_order: 0, offer: { class_keywords: '50+' }, attribution: {} }
// The studio's own page (kind='studio', primary loc-s) and its studio row.
const STUDIO_PAGE = {
  id: 'p-s', organization_id: 'org-un1t', slug: 'stillorgan', kind: 'studio', scope: 'one',
  primary_location_id: 'loc-s', offer_type: 'class_funnel', publish_state: 'live',
  blocks: [{ id: 'cl', type: 'class_funnel', confirm_subject: 'Studio subject' }],
  chrome: { un1t_terms: { terms_link_label: 'T and Cs' } },
}
const STUDIO_ROW = { page_id: 'p-s', location_id: 'loc-s', enabled: true, sort_order: 0, offer: { trial_plan_code: 'tp' }, attribution: {} }
const FROM_STUDIO = {
  blocks: [{ id: 'cl', type: 'class_funnel', confirm_subject: 'Studio subject', trial_plan_code: 'tp' }],
  publicPath: 'stillorgan',
  terms: { terms_link_label: 'T and Cs' },
}

function makeDb({ pages = {}, studios = { 'p-s': [STUDIO_ROW] }, studioPage = STUDIO_PAGE, failPage = false, failStudioPage = false } = {}) {
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
          if (table === 'landing_pages' && eq.kind === 'studio') {
            return failStudioPage ? { data: null, error: { code: 'YY' } } : { data: studioPage, error: null }
          }
          if (table === 'landing_pages') {
            return failPage ? { data: null, error: { code: 'XX' } } : { data: pages[eq.id] || null, error: null }
          }
          return { data: null, error: null }
        },
        then(resolve, reject) {
          const out = table === 'landing_page_studios' ? { data: studios[eq.page_id] || [], error: null } : { data: [], error: null }
          return Promise.resolve(out).then(resolve, reject)
        },
      }
      return q
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('copySourceForRequest', () => {
  it('with a page_id the copy comes from that page merged with its studio row, the path is the studio page slug and the terms are the studio page\'s', async () => {
    const db = makeDb({ pages: { 'p-50': PAGE }, studios: { 'p-50': [ROW], 'p-s': [STUDIO_ROW] } })
    const out = await copySourceForRequest(db, { pageId: 'p-50', locationId: 'loc-s' })
    expect(out.publicPath).toBe('stillorgan')
    expect(out.terms).toMatchObject({ terms_link_label: 'T and Cs' }) // resolved copy (studioTermsCopy): every key present
    expect(out.blocks.find((b) => b.type === 'class_funnel')).toMatchObject({ confirm_subject: 'See you at 50+' })
    expect(out.blocks.find((b) => b.type === 'campaign_funnel')).toMatchObject({ class_keywords: '50+', campaign: '50plus' })
    expect(db.calls.some((c) => c.table === 'landing_page_settings')).toBe(false)
  })

  it('a page_id of the studio page itself carries its own terms without a second read', async () => {
    const db = makeDb({ pages: { 'p-s': STUDIO_PAGE } })
    const out = await copySourceForRequest(db, { pageId: 'p-s', locationId: 'loc-s' })
    expect(out).toEqual(FROM_STUDIO)
    expect(db.calls.filter((c) => c.table === 'landing_pages' && c.eq.kind === 'studio').length).toBe(1) // studioPublicPath only
  })

  it('without a page_id it comes from the studio\'s own page by location, merged with its row', async () => {
    const db = makeDb()
    const out = await copySourceForRequest(db, { pageId: null, locationId: 'loc-s' })
    expect(out).toEqual(FROM_STUDIO)
    const read = db.calls.find((c) => c.table === 'landing_pages')
    expect(read.eq).toEqual({ kind: 'studio', primary_location_id: 'loc-s' })
    expect(db.calls.some((c) => c.table === 'landing_page_settings')).toBe(false)
  })

  it('a miss answers empty copy and never throws', async () => {
    const db = makeDb({ studioPage: null })
    await expect(copySourceForRequest(db, { pageId: null, locationId: 'loc-s' })).resolves.toEqual({ blocks: [], publicPath: null, terms: {} })
  })

  it('a page with no studio row for the request location, or a vanished page, falls back to the studio page', async () => {
    const noRow = makeDb({ pages: { 'p-50': PAGE }, studios: { 'p-50': [{ ...ROW, location_id: 'loc-other' }], 'p-s': [STUDIO_ROW] } })
    expect(await copySourceForRequest(noRow, { pageId: 'p-50', locationId: 'loc-s' })).toEqual(FROM_STUDIO)
    const gone = makeDb({ pages: {} })
    expect(await copySourceForRequest(gone, { pageId: 'p-gone', locationId: 'loc-s' })).toEqual(FROM_STUDIO)
  })

  it('a failed page read logs ids only and falls back; a failed studio page read too ends in empty copy', async () => {
    const db = makeDb({ failPage: true })
    expect(await copySourceForRequest(db, { pageId: 'p-50', locationId: 'loc-s' })).toEqual(FROM_STUDIO)
    expect(logWarn).toHaveBeenCalledWith('landing-pages', expect.any(String), expect.objectContaining({ pageId: 'p-50', locationId: 'loc-s' }))
    const both = makeDb({ failPage: true, failStudioPage: true })
    expect(await copySourceForRequest(both, { pageId: 'p-50', locationId: 'loc-s' })).toEqual({ blocks: [], publicPath: null, terms: {} })
  })

  it('studioPageBlocksFor throws on a read error (the caller decides), and answers empty on a miss', async () => {
    await expect(studioPageBlocksFor(makeDb({ failStudioPage: true }), 'loc-s')).rejects.toThrow()
    expect(await studioPageBlocksFor(makeDb({ studioPage: null }), 'loc-s')).toEqual({ blocks: [], publicPath: null, terms: {} })
  })

  it('a studio page with no row for its studio answers its own blocks unmerged', async () => {
    expect(await studioPageBlocksFor(makeDb({ studios: {} }), 'loc-s')).toEqual({
      blocks: STUDIO_PAGE.blocks, publicPath: 'stillorgan', terms: { terms_link_label: 'T and Cs' },
    })
  })
})
