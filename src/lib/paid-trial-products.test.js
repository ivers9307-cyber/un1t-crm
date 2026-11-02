// HATCH39 — which un1t.online products are a studio's PAID trial (the €39
// 14-day trial). un1t.online sells it as a `pack`, so every read that asks
// "is this a pack" needs this set to tell a trial from a Class Pack.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/trial-studios', () => ({ loadTrialStudios: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { loadTrialStudios } from '@/lib/trial-studios'
import { paidTrialProductIdsFor, paidTrialIdsFromSettings } from './paid-trial-products.js'

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const P1 = '674d62bf-4d4b-4231-b1ba-d53543657bea'
const dbWith = ({ settings = {}, error = null } = {}) => {
  const calls = []
  const q = {
    select: (c) => { calls.push(['select', c]); return q },
    eq: (c, v) => { calls.push(['eq', c, v]); return q },
    maybeSingle: async () => ({ data: error ? null : { settings }, error }),
  }
  return { db: { from: (t) => { calls.push(['from', t]); return q } }, calls }
}

beforeEach(() => {
  vi.mocked(loadTrialStudios).mockReset()
  vi.mocked(loadTrialStudios).mockResolvedValue([{ key: 'hatch', locationId: HATCH, block: { type: 'paid_trial', un1t_product_id: P1 } }])
})

describe('paidTrialIdsFromSettings (pure)', () => {
  it('reads settings.pipelines.paid_trial.un1t_product_ids, trimmed, non-empty strings only', () => {
    expect(paidTrialIdsFromSettings({ pipelines: { paid_trial: { un1t_product_ids: [` ${P1} `, '', 7, 'x'] } } })).toEqual([P1, 'x'])
    expect(paidTrialIdsFromSettings(null)).toEqual([])
    expect(paidTrialIdsFromSettings({ pipelines: { paid_trial: { un1t_product_ids: 'nope' } } })).toEqual([])
  })
})

describe('paidTrialProductIdsFor', () => {
  it('is the setting ∪ the /trial page block for this studio, as a Set', async () => {
    const { db, calls } = dbWith({ settings: { pipelines: { paid_trial: { un1t_product_ids: ['other-product'] } } } })
    const ids = await paidTrialProductIdsFor(db, HATCH)
    expect(ids).toBeInstanceOf(Set)
    expect([...ids].sort()).toEqual([P1, 'other-product'].sort())
    expect(calls[0]).toEqual(['from', 'locations'])
    expect(calls).toContainEqual(['eq', 'id', HATCH])
  })
  it('the block alone, or the setting alone, each suffice; another studio\'s block is ignored', async () => {
    expect([...await paidTrialProductIdsFor(dbWith().db, HATCH)]).toEqual([P1])
    vi.mocked(loadTrialStudios).mockResolvedValue([{ key: 'stillorgan', locationId: 'other-loc', block: { type: 'paid_trial', un1t_product_id: 'S1' } }])
    expect([...await paidTrialProductIdsFor(dbWith({ settings: { pipelines: { paid_trial: { un1t_product_ids: [P1] } } } }).db, HATCH)]).toEqual([P1])
  })
  it('a failed settings read throws (never "no paid trials")', async () => {
    await expect(paidTrialProductIdsFor(dbWith({ error: { message: 'down' } }).db, HATCH)).rejects.toThrow(/settings/)
  })
  it('an unreadable trial page entry for this studio throws; a missing one does not', async () => {
    vi.mocked(loadTrialStudios).mockResolvedValue([{ key: 'hatch', locationId: HATCH, block: null, unreadable: true }])
    await expect(paidTrialProductIdsFor(dbWith().db, HATCH)).rejects.toThrow(/trial page/)
    vi.mocked(loadTrialStudios).mockResolvedValue([])
    expect([...await paidTrialProductIdsFor(dbWith().db, HATCH)]).toEqual([])
  })
  it('a missing location id is an empty set without a read', async () => {
    const { db, calls } = dbWith()
    expect([...await paidTrialProductIdsFor(db, null)]).toEqual([])
    expect(calls).toHaveLength(0)
  })
})


describe('paidTrialProductIdsFor — fail closed on a malformed studios list', () => {
  it('throws when loadTrialStudios does not answer an array', async () => {
    vi.mocked(loadTrialStudios).mockResolvedValue(null)
    await expect(paidTrialProductIdsFor(dbWith().db, HATCH)).rejects.toThrow(/trial page/)
  })
})
