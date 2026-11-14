import { describe, it, expect } from 'vitest'
import {
  CUSTOMER_PROVIDER_KEYS,
  CUSTOMER_FILTER_LABELS,
  buildCustomerQueue,
  teamProviders,
  filterQueue,
} from './customer-queue'

const prov = (key, extra = {}) => ({
  key, label: key, reviewBase: '/x', count: 0, items: [], failedItems: [], ...extra,
})
const ids = (arr) => arr.map((i) => i.id)

describe('customer queue', () => {
  it('exports the keys and labels', () => {
    expect(CUSTOMER_PROVIDER_KEYS).toEqual(['agent_requests', 'trial_purchases', 'corp_promo_claims', 'offer_purchases'])
    expect(CUSTOMER_FILTER_LABELS.agent_requests).toBe('Mia requests')
  })

  it('puts failed Mia items in needsFixing and everything else in waiting, each tagged with providerKey', () => {
    const providers = [
      prov('agent_requests', { count: 2, items: [{ id: 'a' }], failedItems: [{ id: 'f' }] }),
      prov('trial_purchases', { count: 1, items: [{ id: 't' }], failedItems: [{ id: 'ignored' }] }),
    ]
    const q = buildCustomerQueue(providers, 0)
    expect(q.needsFixing).toEqual([{ id: 'f', providerKey: 'agent_requests' }])
    expect(q.waiting).toEqual([
      { id: 'a', providerKey: 'agent_requests' },
      { id: 't', providerKey: 'trial_purchases' },
    ])
  })

  it('orders by class start soonest, then oldest submitted', () => {
    const providers = [prov('agent_requests', {
      items: [
        { id: 'A', submittedAt: '2026-11-10' },
        { id: 'B', details: { starts_at: '2026-11-15T09:00Z' }, submittedAt: '2026-11-13' },
        { id: 'C', details: { starts_at: '2026-11-14T18:00Z' }, submittedAt: '2026-11-13' },
        { id: 'D', submittedAt: '2026-11-12' },
      ],
    })]
    expect(ids(buildCustomerQueue(providers).waiting)).toEqual(['C', 'B', 'A', 'D'])
  })

  it('sorts a missing submittedAt last', () => {
    const providers = [prov('offer_purchases', { items: [{ id: 'x' }, { id: 'y', submittedAt: '2026-11-01' }] })]
    expect(ids(buildCustomerQueue(providers).waiting)).toEqual(['y', 'x'])
  })

  it('builds chips only for providers present, in fixed order, with their counts', () => {
    const providers = [
      prov('offer_purchases', { count: 3 }),
      prov('invoices', { count: 9 }),
      prov('agent_requests', { count: 2 }),
    ]
    const q = buildCustomerQueue(providers)
    expect(q.chips).toEqual([
      { key: 'agent_requests', label: 'Mia requests', count: 2 },
      { key: 'offer_purchases', label: 'Offer sales', count: 3 },
    ])
    expect(q.total).toBe(5)
  })

  it('tolerates a missing provider, missing failedItems and a missing items array', () => {
    expect(buildCustomerQueue([], 0)).toEqual({ needsFixing: [], waiting: [], chips: [], total: 0 })
    const q = buildCustomerQueue([{ key: 'agent_requests', count: 1 }, { key: 'trial_purchases' }])
    expect(q.needsFixing).toEqual([])
    expect(q.waiting).toEqual([])
    expect(q.total).toBe(1)
    expect(buildCustomerQueue(undefined).total).toBe(0)
  })

  it('does not mutate its input', () => {
    const items = [{ id: 'b', submittedAt: '2026-11-02' }, { id: 'a', submittedAt: '2026-11-01' }]
    const providers = [prov('agent_requests', { items })]
    buildCustomerQueue(providers)
    expect(ids(items)).toEqual(['b', 'a'])
    expect(items[0].providerKey).toBeUndefined()
  })

  it('teamProviders drops the four customer keys and keeps order', () => {
    const providers = [prov('z'), prov('agent_requests'), prov('a'), prov('offer_purchases')]
    expect(teamProviders(providers).map((p) => p.key)).toEqual(['z', 'a'])
  })

  it('filterQueue narrows both groups to one providerKey; "all" returns both unchanged', () => {
    const q = {
      needsFixing: [{ id: 'f', providerKey: 'agent_requests' }],
      waiting: [{ id: 'a', providerKey: 'agent_requests' }, { id: 't', providerKey: 'trial_purchases' }],
    }
    expect(filterQueue(q, 'trial_purchases')).toEqual({ needsFixing: [], waiting: [{ id: 't', providerKey: 'trial_purchases' }] })
    expect(filterQueue(q, 'all')).toEqual({ needsFixing: q.needsFixing, waiting: q.waiting })
  })
})
