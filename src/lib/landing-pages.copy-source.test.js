// PAGES.1 — copySourceForRequest: the confirmation copy of a request comes from
// the page the request came from (merged with that page's studio row), else
// from the studio's own page (PR1: landing_page_settings). It never throws.
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
const LEGACY = { public_path: 'stillorgan', blocks: [{ type: 'class_funnel', confirm_subject: 'Legacy subject' }] }

function makeDb({ pages = {}, studios = {}, legacy = LEGACY, failPage = false, failLegacy = false } = {}) {
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
          if (table === 'landing_pages' && eq.kind === 'studio') return { data: { slug: 'stillorgan' }, error: null }
          if (table === 'landing_pages') {
            return failPage ? { data: null, error: { code: 'XX' } } : { data: pages[eq.id] || null, error: null }
          }
          if (table === 'landing_page_settings') {
            return failLegacy ? { data: null, error: { code: 'YY' } } : { data: legacy, error: null }
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
  it('with a page_id the copy comes from that page merged with its studio row, and the path is the studio page slug', async () => {
    const db = makeDb({ pages: { 'p-50': PAGE }, studios: { 'p-50': [ROW] } })
    const out = await copySourceForRequest(db, { pageId: 'p-50', locationId: 'loc-s' })
    expect(out.publicPath).toBe('stillorgan')
    expect(out.blocks.find((b) => b.type === 'class_funnel')).toMatchObject({ confirm_subject: 'See you at 50+' })
    expect(out.blocks.find((b) => b.type === 'campaign_funnel')).toMatchObject({ class_keywords: '50+', campaign: '50plus' })
    expect(db.calls.some((c) => c.table === 'landing_page_settings')).toBe(false)
  })

  it('without a page_id it comes from the studio page (PR1: landing_page_settings) by location', async () => {
    const db = makeDb()
    const out = await copySourceForRequest(db, { pageId: null, locationId: 'loc-s' })
    expect(out).toEqual({ blocks: LEGACY.blocks, publicPath: 'stillorgan' })
    const legacyCall = db.calls.find((c) => c.table === 'landing_page_settings')
    expect(legacyCall.eq).toEqual({ location_id: 'loc-s' })
  })

  it('a miss answers empty copy and never throws', async () => {
    const db = makeDb({ legacy: null })
    await expect(copySourceForRequest(db, { pageId: null, locationId: 'loc-s' })).resolves.toEqual({ blocks: [], publicPath: null })
  })

  it('a page with no studio row for the request location, or a vanished page, falls back to the legacy read', async () => {
    const noRow = makeDb({ pages: { 'p-50': PAGE }, studios: { 'p-50': [{ ...ROW, location_id: 'loc-other' }] } })
    expect(await copySourceForRequest(noRow, { pageId: 'p-50', locationId: 'loc-s' })).toEqual({ blocks: LEGACY.blocks, publicPath: 'stillorgan' })
    const gone = makeDb({ pages: {} })
    expect(await copySourceForRequest(gone, { pageId: 'p-gone', locationId: 'loc-s' })).toEqual({ blocks: LEGACY.blocks, publicPath: 'stillorgan' })
  })

  it('a failed page read logs ids only and falls back; a failed legacy read too ends in empty copy', async () => {
    const db = makeDb({ failPage: true })
    expect(await copySourceForRequest(db, { pageId: 'p-50', locationId: 'loc-s' })).toEqual({ blocks: LEGACY.blocks, publicPath: 'stillorgan' })
    expect(logWarn).toHaveBeenCalledWith('landing-pages', expect.any(String), expect.objectContaining({ pageId: 'p-50', locationId: 'loc-s' }))
    const both = makeDb({ failPage: true, failLegacy: true })
    expect(await copySourceForRequest(both, { pageId: 'p-50', locationId: 'loc-s' })).toEqual({ blocks: [], publicPath: null })
  })

  it('studioPageBlocksFor throws on a read error (the caller decides), and answers empty on a miss', async () => {
    await expect(studioPageBlocksFor(makeDb({ failLegacy: true }), 'loc-s')).rejects.toThrow()
    expect(await studioPageBlocksFor(makeDb({ legacy: null }), 'loc-s')).toEqual({ blocks: [], publicPath: null })
  })
})
