// Tests for src/lib/orders.js (mig 085).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectRetryRecovery, __test } from './orders'

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
  function makeDb({ candidates = [], sortedCandidates = candidates } = {}) {
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
              return Promise.resolve({ data: null, error: null })
            },
            eq: (col, val) => {
              ops.updates.push({ table, patch, col, val })
              return Promise.resolve({ data: null, error: null })
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

describe('RETRY_WINDOW_DAYS', () => {
  it('is 7 days as configured in Phase 2 design', () => {
    expect(__test.RETRY_WINDOW_DAYS).toBe(7)
  })
})
