// Tests for src/lib/orders.js (mig 085).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectRetryRecovery, syncOrderFromRacePayment, __test } from './orders'

describe('mapCarDepositStatus', () => {
  it('maps cars-specific statuses to the orders enum', () => {
    expect(__test.mapCarDepositStatus('paid')).toBe('completed')
    expect(__test.mapCarDepositStatus('failed')).toBe('failed')
    expect(__test.mapCarDepositStatus('cancelled')).toBe('abandoned')
    expect(__test.mapCarDepositStatus('refunded')).toBe('refunded')
    expect(__test.mapCarDepositStatus('sent')).toBe('pending')
    expect(__test.mapCarDepositStatus('terms_accepted')).toBe('pending')
    expect(__test.mapCarDepositStatus(null)).toBe('pending')
    expect(__test.mapCarDepositStatus('weird-future-state')).toBe('pending')
  })
})

describe('detectRetryRecovery', () => {
  function makeDb({ candidates = [], sortedCandidates = candidates, updateError = null } = {}) {
    const ops = { selects: [], updates: [] }
    return {
      _ops: ops,
      from: (table) => {
        return {
          select: () => {
            const chain = {
              eq: () => chain,
              in: () => chain,
              gte: () => chain,
              lt: () => chain,
              neq: () => chain,
              order: () => Promise.resolve({ data: sortedCandidates, error: null }),
              then: (cb) => cb({ data: candidates, error: null }),
            }
            ops.selects.push({ table })
            return chain
          },
          update: (patch) => ({
            in: (col, vals) => {
              ops.updates.push({ table, patch, col, vals })
              return Promise.resolve({ data: null, error: updateError })
            },
            eq: (col, val) => {
              ops.updates.push({ table, patch, col, val })
              return Promise.resolve({ data: null, error: updateError })
            },
          }),
        }
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when order is not completed', async () => {
    const db = makeDb()
    const r = await detectRetryRecovery({
      db,
      order: { status: 'pending', contact_email: 'x@y.com', source_type: 'race_registration' },
    })
    expect(r.recoveredCount).toBe(0)
    expect(db._ops.updates).toHaveLength(0)
  })

  it('does nothing when no contact_email', async () => {
    const db = makeDb()
    const r = await detectRetryRecovery({
      db,
      order: { status: 'completed', source_type: 'race_registration' },
    })
    expect(r.recoveredCount).toBe(0)
  })

  it('returns 0 when no failed/abandoned candidates exist', async () => {
    const db = makeDb({ candidates: [] })
    const r = await detectRetryRecovery({
      db,
      order: {
        id: 'new-1',
        status: 'completed',
        contact_email: 'sarah@example.com',
        source_type: 'race_registration',
        completed_at: new Date().toISOString(),
      },
    })
    expect(r.recoveredCount).toBe(0)
  })

  it('recovers earlier failed orders and points the new order back', async () => {
    const candidates = [
      { id: 'old-1', status: 'failed' },
      { id: 'old-2', status: 'abandoned' },
    ]
    const sorted = [
      { id: 'old-2', created_at: '2026-04-30T00:00:00Z' }, // newer
      { id: 'old-1', created_at: '2026-04-29T00:00:00Z' },
    ]
    const db = makeDb({ candidates, sortedCandidates: sorted })
    const r = await detectRetryRecovery({
      db,
      order: {
        id: 'new-1',
        status: 'completed',
        contact_email: 'sarah@example.com',
        source_type: 'race_registration',
        completed_at: '2026-05-01T00:00:00Z',
      },
    })
    expect(r.recoveredCount).toBe(2)
    // Two updates: bulk recovered marking + retry_of_order_id pointer
    expect(db._ops.updates).toHaveLength(2)
    const recoveredUpdate = db._ops.updates.find(u => u.col === 'id' && Array.isArray(u.vals))
    expect(recoveredUpdate.patch.status).toBe('recovered')
    expect(recoveredUpdate.patch.superseded_by_order_id).toBe('new-1')
    const pointerUpdate = db._ops.updates.find(u => u.col === 'id' && !Array.isArray(u.vals))
    expect(pointerUpdate.patch.retry_of_order_id).toBe('old-2') // newer of the two
  })
})

describe('detectRetryRecovery — a failed recovery write', () => {
  it('is logged, never thrown, and reports nothing recovered; the pointer is not set', async () => {
    const updates = []
    const db = {
      from: () => ({
        select: () => {
          const chain = { eq: () => chain, in: () => chain, gte: () => chain, lt: () => chain, neq: () => chain,
            then: (cb) => cb({ data: [{ id: 'old-1', status: 'failed' }], error: null }) }
          return chain
        },
        update: (patch) => ({
          in: () => { updates.push(patch); return Promise.resolve({ data: null, error: { message: 'connection reset' } }) },
          eq: () => { updates.push(patch); return Promise.resolve({ data: null, error: null }) },
        }),
      }),
    }
    const r = await detectRetryRecovery({
      db,
      order: { id: 'new-1', status: 'completed', contact_email: 'sarah@example.com', source_type: 'race_registration', completed_at: '2026-05-01T00:00:00Z' },
    })
    expect(r.recoveredCount).toBe(0)
    expect(updates).toHaveLength(1) // the retry_of pointer is not written over a failed marking
  })
})

describe('syncOrderFromRacePayment — the order stays with its studio', () => {
  // A recording fake: reads answer from `answers[table]` (a value or a
  // function of the recorded ops), the upsert echoes its row back.
  function fakeDb(answers) {
    const calls = []
    return {
      calls,
      from(table) {
        const q = { table, ops: [] }
        calls.push(q)
        const answer = () => {
          const up = q.ops.find((o) => o[0] === 'upsert')
          if (up) return Promise.resolve({ data: { id: 'o1', ...up[1] }, error: null })
          const a = answers[table]
          return Promise.resolve((typeof a === 'function' ? a(q) : a) ?? { data: null, error: null })
        }
        const b = {}
        for (const name of ['select', 'eq', 'in', 'gte', 'lt', 'neq', 'upsert']) b[name] = (...args) => { q.ops.push([name, ...args]); return b }
        b.maybeSingle = () => answer()
        b.single = () => answer()
        b.then = (res, rej) => answer().then(res, rej)
        return b
      },
    }
  }
  const payment = { id: 'p1', race_event_id: 'e-hatch', contact_email: 'a@example.test', amount_cents: 5000, status: 'pending' }
  const upserted = (db) => db.calls.find((c) => c.ops.some((o) => o[0] === 'upsert')).ops.find((o) => o[0] === 'upsert')[1]

  it('a new order takes its studio and organisation from the event', async () => {
    const db = fakeDb({
      orders: { data: null, error: null },
      race_events: { data: { location_id: 'L-hatch', locations: { organization_id: 'org-1' } }, error: null },
    })
    await syncOrderFromRacePayment({ db, payment })
    expect(upserted(db)).toMatchObject({ location_id: 'L-hatch', organization_id: 'org-1', source_id: 'p1', status: 'pending' })
    const lookup = db.calls.find((c) => c.table === 'orders' && !c.ops.some((o) => o[0] === 'upsert'))
    expect(lookup.ops).toContainEqual(['eq', 'source_type', 'race_registration'])
    expect(lookup.ops).toContainEqual(['eq', 'source_id', 'p1'])
  })

  it('an existing order keeps its studio after the payment moved to another studio\'s event', async () => {
    const db = fakeDb({
      // the retry-recovery candidate read (status in failed/abandoned) finds none
      orders: (q) => (q.ops.some((o) => o[0] === 'in')
        ? { data: [], error: null }
        : { data: { id: 'o1', location_id: 'L-stillorgan', organization_id: 'org-1' }, error: null }),
      race_events: { data: { location_id: 'L-hatch', locations: { organization_id: 'org-2' } }, error: null },
    })
    await syncOrderFromRacePayment({ db, payment: { ...payment, status: 'completed', completed_at: null } })
    expect(upserted(db)).toMatchObject({ location_id: 'L-stillorgan', organization_id: 'org-1', status: 'completed' })
    expect(db.calls.some((c) => c.table === 'race_events')).toBe(false)
  })

  it('a failed lookup of the existing order still syncs it, deriving the studio from the event', async () => {
    // The ledger update (and the contact event the callers emit after it, in
    // the same try) matter more than a wrong studio on a rare moved order.
    const db = fakeDb({
      orders: { data: null, error: { message: 'timeout' } },
      race_events: { data: { location_id: 'L-hatch', locations: { organization_id: 'org-1' } }, error: null },
    })
    await expect(syncOrderFromRacePayment({ db, payment })).resolves.toMatchObject({ id: 'o1' })
    expect(upserted(db)).toMatchObject({ location_id: 'L-hatch', organization_id: 'org-1', source_id: 'p1' })
  })

  it('an existing order with no organisation takes it from its OWN studio, not the event\'s', async () => {
    const db = fakeDb({
      orders: (q) => (q.ops.some((o) => o[0] === 'in')
        ? { data: [], error: null }
        : { data: { id: 'o1', location_id: 'L-stillorgan', organization_id: null }, error: null }),
      locations: (q) => (q.ops.some((o) => o[0] === 'eq' && o[1] === 'id' && o[2] === 'L-stillorgan')
        ? { data: { organization_id: 'org-stillorgan' }, error: null }
        : { data: null, error: null }),
      race_events: { data: { location_id: 'L-hatch', locations: { organization_id: 'org-hatch' } }, error: null },
    })
    await syncOrderFromRacePayment({ db, payment })
    expect(upserted(db)).toMatchObject({ location_id: 'L-stillorgan', organization_id: 'org-stillorgan' })
    expect(db.calls.some((c) => c.table === 'race_events')).toBe(false)
  })
})

describe('RETRY_WINDOW_DAYS', () => {
  it('is 7 days as configured in Phase 2 design', () => {
    expect(__test.RETRY_WINDOW_DAYS).toBe(7)
  })
})
