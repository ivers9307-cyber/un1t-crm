import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
const paidTrialIds = vi.hoisted(() => vi.fn())
vi.mock('@/lib/paid-trial-products', () => ({ paidTrialProductIdsFor: paidTrialIds }))

import { listEntryOptions } from './pipeline-entry-options'
import { DEFAULT_LEAD_SOURCES } from '@/lib/schemas'
import { PLATFORM_TAGS } from '@/lib/sequences/tag-vocabulary'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const ORG = 'o0000000-0000-4000-8000-000000000001'

// Logs every awaited query { table, select, filters, range } and answers it
// from `tables[table](entry)`.
function makeDb(tables) {
  const log = []
  return {
    log,
    from(table) {
      const entry = { table, select: null, filters: {}, range: null }
      const q = {
        select(c) { entry.select = c; return q },
        eq(c, v) { entry.filters[c] = v; return q },
        in(c, v) { entry.filters[c] = v; return q },
        is(c, v) { entry.filters[c] = v; return q },
        order() { return q },
        range(a, b) { entry.range = [a, b]; return q },
        maybeSingle() { entry.single = true; return q },
        then(resolve, reject) {
          log.push(entry)
          const fn = tables[table]
          const res = fn ? fn(entry) : { data: [], error: null }
          return Promise.resolve(res).then(resolve, reject)
        },
      }
      return q
    },
  }
}

let db
beforeEach(() => { vi.clearAllMocks(); paidTrialIds.mockReset(); paidTrialIds.mockResolvedValue(new Set()) })

describe('listEntryOptions', () => {
  it('unknownTypeIs400', async () => {
    db = makeDb({})
    expect(await listEntryOptions(db, { locationId: LOC, type: 'nope' })).toMatchObject({ ok: false, status: 400, code: 'unknown_type' })
    expect(await listEntryOptions(db, { locationId: LOC, type: 'trial_purchase', match: 'nope' })).toMatchObject({ ok: false, status: 400 })
    expect(db.log).toEqual([])
  })

  describe('entryOptionsPerType', () => {
    it('trial_purchase plan_code: purchases plus landing page offers, studio-scoped', async () => {
      db = makeDb({
        trial_purchases: () => ({ data: [
          { id: '1', plan_code: 'P39', product_name: '14 Day Reset' },
          { id: '2', plan_code: 'P39', product_name: '14 Day Reset' },
          { id: '3', plan_code: 'FREE', product_name: 'Free trial' },
        ], error: null }),
        landing_page_studios: () => ({ data: [
          { page_id: 'pg1', enabled: true, offer: { plan_code: 'P50' } },
          { page_id: 'pg2', enabled: true, offer: { plan_code: 'P39' } },
          { page_id: 'pg3', enabled: false, offer: {} },
        ], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'trial_purchase', match: 'plan_code' })
      expect(res).toEqual({ ok: true, options: [
        { value: 'FREE', label: 'FREE', hint: 'Free trial' },
        { value: 'P39', label: 'P39', hint: '14 Day Reset' },
        { value: 'P50', label: 'P50', hint: 'On a landing page' },
      ] })
      for (const e of db.log) expect(e.filters.location_id).toBe(LOC)
      expect(db.log.find((e) => e.table === 'trial_purchases').range).toEqual([0, 999])
    })

    it('trial_purchase landing_path: distinct paths at the studio', async () => {
      db = makeDb({
        trial_purchases: () => ({ data: [
          { id: '1', landing_path: '/trial' }, { id: '2', landing_path: '/trial' }, { id: '3', landing_path: null }, { id: '4', landing_path: '/50plus' },
        ], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'trial_purchase', match: 'landing_path' })
      expect(res.options.map((o) => o.value)).toEqual(['/50plus', '/trial'])
      expect(db.log).toHaveLength(1)
      expect(db.log[0].filters).toEqual({ location_id: LOC })
    })

    it('trial_purchase landing_path pages past 1000 rows', async () => {
      const page = (from, n, path) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), landing_path: path }))
      db = makeDb({
        trial_purchases: (e) => ({ data: e.range[0] === 0 ? page(0, 1000, '/a') : page(1000, 3, '/b'), error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'trial_purchase', match: 'landing_path' })
      expect(res.options.map((o) => o.value)).toEqual(['/a', '/b'])
      expect(db.log.map((e) => e.range)).toEqual([[0, 999], [1000, 1999]])
    })

    it('trial_purchase page_id: the org\'s pages with a row for this studio', async () => {
      db = makeDb({
        locations: () => ({ data: { organization_id: ORG }, error: null }),
        landing_page_studios: () => ({ data: [
          { page_id: 'pg1', enabled: true, offer: {} },
          { page_id: 'pg2', enabled: false, offer: {} },
        ], error: null }),
        landing_pages: () => ({ data: [
          { id: 'pg1', slug: 'reset', title: '14 Day Reset' },
          { id: 'pg2', slug: '50plus', title: '50 plus' },
        ], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'trial_purchase', match: 'page_id' })
      expect(res.options).toEqual([
        { value: 'pg1', label: '14 Day Reset', hint: '/reset' },
        { value: 'pg2', label: '50 plus', hint: '/50plus (switched off at this studio)' },
      ])
      const loc = db.log.find((e) => e.table === 'locations')
      expect(loc.filters).toEqual({ id: LOC })
      expect(loc.select).toBe('organization_id')
      expect(db.log.find((e) => e.table === 'landing_page_studios').filters).toEqual({ location_id: LOC })
      expect(db.log.find((e) => e.table === 'landing_pages').filters).toEqual({ organization_id: ORG, id: ['pg1', 'pg2'] })
    })

    it('corp_promo: this studio\'s corp_promos rows only, by key; a switched-off one says so', async () => {
      const OTHER = 'a0000000-0000-4000-8000-000000000002'
      const rows = [
        { id: 'p1', location_id: LOC, key: 'hatch-3-free', name: 'Corporate trial (Hatch Street)', platform: 'un1t_online', credits: 3, expires_in_days: 7, live: true, tag: 't', lead_source: 'corp_promo' },
        { id: 'p2', location_id: LOC, key: 'hatch-old', name: 'Old promo', platform: 'un1t_online', credits: 3, expires_in_days: 7, live: false, tag: 't', lead_source: 'corp_promo' },
        { id: 'p3', location_id: OTHER, key: 'stillorgan-newstart', name: 'New Start (Stillorgan)', platform: 'glofox', credits: 3, expires_in_days: 7, live: true, tag: 't', lead_source: 'corp_promo' },
      ]
      db = makeDb({ corp_promos: (e) => ({ data: rows.filter((r) => r.location_id === e.filters.location_id), error: null }) })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'corp_promo' })
      expect(res).toEqual({ ok: true, options: [
        { value: 'hatch-3-free', label: 'Corporate trial (Hatch Street)', hint: '' },
        { value: 'hatch-old', label: 'Old promo', hint: 'not live' },
      ] })
      expect(db.log.map((e) => e.table)).toEqual(['corp_promos'])
      expect(db.log[0].filters).toEqual({ location_id: LOC })
      expect(db.log[0].range).toEqual([0, 999])
    })

    it('corp_promo: a failed read is 503, never "no promos"', async () => {
      db = makeDb({ corp_promos: () => ({ data: null, error: { message: 'boom' } }) })
      expect(await listEntryOptions(db, { locationId: LOC, type: 'corp_promo' })).toMatchObject({ ok: false, status: 503 })
    })

    it("lead_source: the studio's vocabulary (defaults, the owner's list, values seen on contacts)", async () => {
      db = makeDb({
        locations: () => ({ data: { id: LOC, settings: { lead_sources: ['Clubhouse_Partner'] } }, error: null }),
        contacts: () => ({ data: [{ id: 'c1', lead_source: 'corp_promo', last_lead_source: 'META' }], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'lead_source' })
      expect(res.ok).toBe(true)
      expect(res.options.map((o) => o.value)).toEqual([...DEFAULT_LEAD_SOURCES, 'clubhouse_partner', 'corp_promo'])
      expect(res.options.find((o) => o.value === 'walkin')).toEqual({ value: 'walkin', label: 'Walk-in', hint: 'walkin' })
      expect(res.options.find((o) => o.value === 'corp_promo')).toEqual({ value: 'corp_promo', label: 'corp_promo' })
      const contactsRead = db.log.find((e) => e.table === 'contacts')
      expect(contactsRead.filters).toEqual({ location_id: LOC })
      expect(contactsRead.range).toEqual([0, 999])
    })

    it('lead_source: a failed contacts read is 503, never the defaults alone', async () => {
      db = makeDb({
        locations: () => ({ data: { id: LOC, settings: {} }, error: null }),
        contacts: () => ({ data: null, error: { message: 'boom' } }),
      })
      expect(await listEntryOptions(db, { locationId: LOC, type: 'lead_source' })).toMatchObject({ ok: false, status: 503 })
    })

    it('glofox_plan: active memberships at the studio', async () => {
      db = makeDb({
        glofox_memberships: () => ({ data: [
          { glofox_membership_id: 'm1', name: 'Unlimited' }, { glofox_membership_id: 'm2', name: '10 Class Pack' }, { glofox_membership_id: 'm3', name: null },
        ], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'glofox_plan' })
      expect(res.options).toEqual([{ value: '10 Class Pack', label: '10 Class Pack' }, { value: 'Unlimited', label: 'Unlimited' }])
      expect(db.log[0].filters).toEqual({ location_id: LOC, active: true })
    })

    it('un1t_product: active products at the studio, price in the label, by title', async () => {
      db = makeDb({
        un1t_products: () => ({ data: [
          { un1t_id: 'p1', title: '14 Day Reset', price_cents: 3900 },
          { un1t_id: 'p2', title: 'Free trial', price_cents: null },
          { un1t_id: 'p3', title: 'Pack', price_cents: 4950 },
        ], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'un1t_product' })
      expect(res).toEqual({ ok: true, options: [
        { value: 'p1', label: '14 Day Reset · €39' },
        { value: 'p2', label: 'Free trial' },
        { value: 'p3', label: 'Pack · €49.50' },
      ] })
      expect(db.log[0].filters).toEqual({ location_id: LOC, status: 'active' })
    })

    it('un1t_product: leaves out the paid-trial product', async () => {
      paidTrialIds.mockResolvedValue(new Set(['p1']))
      db = makeDb({
        un1t_products: () => ({ data: [
          { un1t_id: 'p1', title: '14 Day Reset', price_cents: 3900 },
          { un1t_id: 'p3', title: 'Pack', price_cents: 4950 },
        ], error: null }),
      })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'un1t_product' })
      expect(res.options.map((o) => o.value)).toEqual(['p3'])
    })

    it('un1t_product: a failed paid-trial read is 503, not a full list', async () => {
      paidTrialIds.mockRejectedValue(new Error('down'))
      db = makeDb({ un1t_products: () => ({ data: [{ un1t_id: 'p1', title: 'X', price_cents: 100 }], error: null }) })
      expect(await listEntryOptions(db, { locationId: LOC, type: 'un1t_product' })).toMatchObject({ ok: false, status: 503 })
    })

    it('un1t_product: a failed read is 503', async () => {
      db = makeDb({ un1t_products: () => ({ data: null, error: { message: 'boom' } }) })
      expect(await listEntryOptions(db, { locationId: LOC, type: 'un1t_product' })).toMatchObject({ ok: false, status: 503 })
    })

    it('tag: the studio vocabulary from the /api/segments helper', async () => {
      db = makeDb({ contact_tags: () => ({ data: [{ tag: 'my-sequence-tag' }, { tag: 'my-sequence-tag' }], error: null }) })
      const res = await listEntryOptions(db, { locationId: LOC, type: 'tag' })
      expect(res.options[0]).toMatchObject({ value: 'my-sequence-tag', label: 'my-sequence-tag' })
      const values = res.options.map((o) => o.value)
      for (const t of PLATFORM_TAGS) expect(values).toContain(t)
      expect(db.log[0].filters).toEqual({ location_id: LOC, removed_at: null })
    })
  })

  it('aFailedReadIs503', async () => {
    db = makeDb({ glofox_memberships: () => ({ data: null, error: { message: 'boom' } }) })
    expect(await listEntryOptions(db, { locationId: LOC, type: 'glofox_plan' })).toMatchObject({ ok: false, status: 503 })
    db = makeDb({ trial_purchases: () => ({ data: null, error: { message: 'boom' } }) })
    expect(await listEntryOptions(db, { locationId: LOC, type: 'trial_purchase', match: 'landing_path' })).toMatchObject({ ok: false, status: 503 })
  })
})
