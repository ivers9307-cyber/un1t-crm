// BLACKFRIDAY.9 — /offer-sales reads pending and fulfilled separately, both
// inside the active location, and pages pending past the 1,000-row cap.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ queries: [], pendingPages: [], fulfilled: { data: [], error: null }, logError: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (u) => { throw new Error(`redirect ${u}`) } }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: async () => ({ activeLocation: { id: 'loc-h', timezone: 'Europe/Dublin' } }) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('@/lib/log', () => ({ logError: h.logError, logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/components/OfferSalesList', () => ({ default: () => null }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const q = { table, calls: [] }
      h.queries.push(q)
      const c = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            const pending = q.calls.some(([m, a]) => m === 'is' && a[0] === 'fulfilled_at')
            const result = pending
              ? (h.pendingPages[q.calls.find(([m]) => m === 'range')[1][0] / 1000] ?? { data: [], error: null })
              : h.fulfilled
            return (res) => res(result)
          }
          return (...a) => { q.calls.push([prop, a]); return c }
        },
      })
      return c
    },
  }),
}))

import OfferSalesPage from './page'

const rows = (n, p = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }))
const findList = (el) => {
  const kids = [].concat(el?.props?.children ?? [])
  for (const k of kids) {
    if (k?.props?.pending) return k
    const f = k && typeof k === 'object' ? findList(k) : null
    if (f) return f
  }
  return null
}

beforeEach(() => {
  h.queries = []
  h.pendingPages = []
  h.fulfilled = { data: [], error: null }
  h.logError.mockReset()
})

describe('/offer-sales', () => {
  it('pages every pending sale oldest first, and reads the fulfilled tail on its own', async () => {
    h.pendingPages = [{ data: rows(1000, 'a'), error: null }, { data: rows(5, 'b'), error: null }]
    h.fulfilled = { data: rows(3, 'f'), error: null }
    const list = findList(await OfferSalesPage())
    expect(list.props.pending).toHaveLength(1005)
    expect(list.props.fulfilled).toHaveLength(3)

    const pendingQs = h.queries.filter((q) => q.calls.some(([m, a]) => m === 'is' && a[0] === 'fulfilled_at'))
    expect(pendingQs).toHaveLength(2)
    for (const q of pendingQs) {
      expect(q.calls).toContainEqual(['eq', ['location_id', 'loc-h']])
      expect(q.calls).toContainEqual(['eq', ['state', 'paid']])
      expect(q.calls).toContainEqual(['is', ['fulfilled_at', null]])
      expect(q.calls).toContainEqual(['order', ['paid_at', { ascending: true }]])
    }
    expect(pendingQs.map((q) => q.calls.find(([m]) => m === 'range')[1])).toEqual([[0, 999], [1000, 1999]])

    const doneQ = h.queries.find((q) => q.calls.some(([m]) => m === 'not'))
    expect(doneQ.calls).toContainEqual(['eq', ['location_id', 'loc-h']])
    expect(doneQ.calls).toContainEqual(['not', ['fulfilled_at', 'is', null]])
    expect(doneQ.calls).toContainEqual(['order', ['fulfilled_at', { ascending: false }]])
    expect(doneQ.calls).toContainEqual(['limit', [10]])
  })

  it('a failed read is logged and shown, never silently empty', async () => {
    h.pendingPages = [{ data: null, error: { code: '57014' } }]
    h.fulfilled = { data: null, error: { code: '57014' } }
    const page = await OfferSalesPage()
    expect(h.logError).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(page)).toContain('Some sales could not be loaded')
  })
})
