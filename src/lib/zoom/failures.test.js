import { describe, it, expect, vi } from 'vitest'
import {
  isPermanentZoomFailure, loadParkedNumbers, parkingBudgetExhausted,
  PARK_BUDGET, ZOOM_SYNC_PROVIDER,
} from './failures'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

/**
 * Stub of the two builder chains this module uses:
 *   loadParkedNumbers      → .select('payload').eq().in().order().limit(n)
 *   parkingBudgetExhausted → .select('id',{count,head}).eq().in()   [awaited]
 * The filters are applied for real so a query that forgets one cannot pass, and
 * `order` is recorded so the deterministic-truncation guarantee is testable.
 *
 * The count chain has no terminal call, so the chain object is itself a
 * thenable — which is exactly what supabase-js builders are.
 */
function stubDb(rows, { error = null, throws = false } = {}) {
  const calls = []
  const orders = []
  return {
    calls,
    orders,
    from: (table) => {
      calls.push(table)
      const filters = {}
      let headCount = false
      const matched = () => rows.filter((r) => Object.entries(filters).every(([col, value]) => (
        Array.isArray(value) ? value.includes(r[col]) : r[col] === value
      )))
      const chain = {
        select: (_cols, opts) => { if (opts?.head) headCount = true; return chain },
        eq: (col, value) => { filters[col] = value; return chain },
        in: (col, values) => { filters[col] = values; return chain },
        order: (col, opts) => { orders.push([col, opts]); return chain },
        limit: (n) => {
          if (throws) throw new Error('boom')
          if (error) return Promise.resolve({ data: null, error })
          return Promise.resolve({ data: matched().slice(0, n), error: null })
        },
        // Thenable, for the head:true count chain that never calls .limit().
        then: (resolve, reject) => {
          if (throws) { try { throw new Error('boom') } catch (e) { return reject(e) } }
          if (error) return resolve({ data: null, count: null, error })
          return resolve(headCount
            ? { data: null, count: matched().length, error: null }
            : { data: matched(), count: null, error: null })
        },
      }
      return chain
    },
  }
}

const parkedRow = (e164, over = {}) => ({
  provider: ZOOM_SYNC_PROVIDER,
  status: 'pending',
  payload: { op: 'create', e164, name: 'Aoife Ryan', contactId: 'c1' },
  ...over,
})

describe('isPermanentZoomFailure', () => {
  it.each([400, 403, 404, 409, 422])('treats %d as a verdict on the payload', (status) => {
    expect(isPermanentZoomFailure(status)).toBe(true)
  })

  it.each([
    [401, 'our token — zoomFetch re-mints, and a rotated credential heals it'],
    [408, 'Zoom timed out reading the request'],
    [429, 'rate limited — the queue retry is exactly right'],
    [500, 'Zoom broke'],
    [503, 'Zoom is down'],
  ])('keeps %d retryable (%s)', (status) => {
    expect(isPermanentZoomFailure(status)).toBe(false)
  })

  it('treats a missing status as transient — never park on a guess', () => {
    expect(isPermanentZoomFailure(undefined)).toBe(false)
    expect(isPermanentZoomFailure(null)).toBe(false)
    expect(isPermanentZoomFailure(NaN)).toBe(false)
    expect(isPermanentZoomFailure('400')).toBe(false)
  })
})

describe('loadParkedNumbers', () => {
  it('returns the E.164 of every pending row for this provider', async () => {
    const db = stubDb([parkedRow('+87654567890'), parkedRow('+800860588525')])
    const parked = await loadParkedNumbers(db)
    expect([...parked].sort()).toEqual(['+800860588525', '+87654567890'])
    expect(db.calls).toContain('webhook_dead_letter')
  })

  it('ignores rows another provider parked', async () => {
    const db = stubDb([
      parkedRow('+353871111111'),
      parkedRow('+353872222222', { provider: 'postmark_queue' }),
    ])
    expect([...await loadParkedNumbers(db)]).toEqual(['+353871111111'])
  })

  it('un-parks a RESOLVED row — that is how an operator retries a fixed number', async () => {
    const db = stubDb([parkedRow('+353871111111', { status: 'resolved' })])
    expect(await loadParkedNumbers(db)).toEqual(new Set())
  })

  // The defect this replaced: filtering on status='pending' alone made
  // "Discard" the one button that RESTARTED the nightly failure loop. Discard
  // means "this number is not getting fixed", so it is the case where the
  // suppression must persist — otherwise the reconcile re-enqueues it, Zoom
  // 400s it, and the worker parks a NEW pending row, every night, forever.
  it('keeps a DISCARDED row parked — discard is a decision, not a retry', async () => {
    const db = stubDb([parkedRow('+353872222222', { status: 'discarded' })])
    expect([...await loadParkedNumbers(db)]).toEqual(['+353872222222'])
  })

  it('keeps a FAILED row parked', async () => {
    const db = stubDb([parkedRow('+353873333333', { status: 'failed' })])
    expect([...await loadParkedNumbers(db)]).toEqual(['+353873333333'])
  })

  it('orders the read so truncation past the cap is deterministic', async () => {
    const db = stubDb([parkedRow('+353871111111')])
    await loadParkedNumbers(db)
    expect(db.orders).toEqual([['received_at', { ascending: true }]])
  })

  it('skips a row whose payload carries no number', async () => {
    const db = stubDb([
      parkedRow('+353871111111'),
      { provider: ZOOM_SYNC_PROVIDER, status: 'pending', payload: {} },
      { provider: ZOOM_SYNC_PROVIDER, status: 'pending', payload: null },
    ])
    expect([...await loadParkedNumbers(db)]).toEqual(['+353871111111'])
  })

  it('fails OPEN on a read error — a suppression list that cannot be read must not suppress', async () => {
    expect(await loadParkedNumbers(stubDb([], { error: { message: 'nope' } }))).toEqual(new Set())
    expect(await loadParkedNumbers(stubDb([], { throws: true }))).toEqual(new Set())
    expect(await loadParkedNumbers(null)).toEqual(new Set())
  })
})

/**
 * The circuit breaker. isPermanentZoomFailure() cannot tell a bad phone number
 * from Zoom refusing the whole account (a dropped scope, a lapsed plan, a
 * quota) — both are a 4xx. Without a budget, the account-level case parks a row
 * per number, which on a cold start is ~6,300 PERMANENT suppressions bought
 * with one credential fault.
 */
describe('parkingBudgetExhausted', () => {
  const many = (n, status = 'pending') =>
    Array.from({ length: n }, (_, i) => parkedRow(`+35387${String(i).padStart(7, '0')}`, { status }))

  it('is not exhausted at the steady-state population', async () => {
    expect(await parkingBudgetExhausted(stubDb(many(5)))).toBe(false)
    expect(await parkingBudgetExhausted(stubDb(many(PARK_BUDGET - 1)))).toBe(false)
  })

  it('is exhausted at the budget and above', async () => {
    expect(await parkingBudgetExhausted(stubDb(many(PARK_BUDGET)))).toBe(true)
    expect(await parkingBudgetExhausted(stubDb(many(PARK_BUDGET + 200)))).toBe(true)
  })

  it('counts discarded rows too — they occupy the budget like any other', async () => {
    expect(await parkingBudgetExhausted(stubDb(many(PARK_BUDGET, 'discarded')))).toBe(true)
  })

  it('ignores rows another provider parked', async () => {
    const rows = many(PARK_BUDGET).map((r) => ({ ...r, provider: 'postmark_queue' }))
    expect(await parkingBudgetExhausted(stubDb(rows))).toBe(false)
  })

  it('does NOT count rows an operator already resolved', async () => {
    expect(await parkingBudgetExhausted(stubDb(many(PARK_BUDGET, 'resolved')))).toBe(false)
  })

  // Opposite direction to loadParkedNumbers, deliberately: an unreadable count
  // must not disable the per-number parking that fixes the live loop.
  it('fails OPEN — an unreadable count never blocks parking', async () => {
    expect(await parkingBudgetExhausted(stubDb([], { error: { message: 'nope' } }))).toBe(false)
    expect(await parkingBudgetExhausted(stubDb([], { throws: true }))).toBe(false)
    expect(await parkingBudgetExhausted(null)).toBe(false)
  })
})
