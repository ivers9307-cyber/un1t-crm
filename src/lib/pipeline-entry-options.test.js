import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { listEntryOptions } from './pipeline-entry-options'
import { CORP_PROMOS } from '@/lib/corp-promos'
import { leadSourceSchema } from '@/lib/schemas'
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
beforeEach(() => vi.clearAllMocks())

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

    it('corp_promo: the registry, no query', async () => {
      db = makeDb({})
      const res = await listEntryOptions(db, { locationId: LOC, type: 'corp_promo' })
      expect(res.options).toHaveLength(Object.keys(CORP_PROMOS).length)
      expect(res.options[0]).toEqual({ value: 'hatch-3-free', label: 'Corporate trial (Hatch Street)', hint: 'Hatch Street' })
      expect(res.options.find((o) => o.value === 'stillorgan-newstart').hint).toBe('Stillorgan')
      expect(db.log).toEqual([])
    })

    it('lead_source: the enum, no query', async () => {
      db = makeDb({})
      const res = await listEntryOptions(db, { locationId: LOC, type: 'lead_source' })
      expect(res.options.map((o) => o.value)).toEqual(leadSourceSchema.options)
      expect(db.log).toEqual([])
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
