// APPROVALSQ.2 — the pure rules behind "clear several Mia requests at once".
import { describe, it, expect, vi } from 'vitest'
import { isBulkClearable, bookingWarningCount, runBulkClear, runBulkUndo } from './bulk-clear.js'

describe('isBulkClearable', () => {
  it('is true only for Mia requests, waiting or failed', () => {
    expect(isBulkClearable({ providerKey: 'agent_requests', id: 'a' })).toBe(true)
    expect(isBulkClearable({ providerKey: 'agent_requests', id: 'a', failed: true })).toBe(true)
    expect(isBulkClearable({ providerKey: 'trial_purchases', id: 't' })).toBe(false)
    expect(isBulkClearable({ providerKey: 'corp_promo_claims', id: 'c' })).toBe(false)
    expect(isBulkClearable({ providerKey: 'offer_purchases', id: 'o' })).toBe(false)
    expect(isBulkClearable({ id: 'x' })).toBe(false)
    expect(isBulkClearable(null)).toBe(false)
  })
})

describe('bookingWarningCount', () => {
  const mia = (kind, extra = {}) => ({ providerKey: 'agent_requests', id: kind, kind, ...extra })
  it('counts waiting class bookings and consultations only', () => {
    const items = [
      mia('class_booking'),
      mia('consultation'),
      mia('pause'),
      mia('class_booking', { failed: true }),
    ]
    expect(bookingWarningCount(items)).toBe(2)
  })
  it('is 0 for an empty or missing list', () => {
    expect(bookingWarningCount([])).toBe(0)
    expect(bookingWarningCount(undefined)).toBe(0)
  })
})

describe('runBulkClear', () => {
  it('calls clearOne once per id with the note, strictly in order and never in parallel', async () => {
    const log = []
    let active = 0
    let maxActive = 0
    const clearOne = vi.fn(async (id, note) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      log.push(`start ${id} ${note}`)
      await new Promise((r) => setTimeout(r, 1))
      log.push(`end ${id}`)
      active -= 1
      return { ok: true }
    })
    const res = await runBulkClear(['a', 'b', 'c'], { note: 'dup', clearOne })
    expect(res).toEqual({ cleared: ['a', 'b', 'c'], failed: [] })
    expect(maxActive).toBe(1)
    expect(log).toEqual(['start a dup', 'end a', 'start b dup', 'end b', 'start c dup', 'end c'])
  })

  it('counts ok:false, a missing ok and a throw as failed, and never stops early', async () => {
    const clearOne = vi.fn(async (id) => {
      if (id === 'b') return { ok: false }
      if (id === 'c') throw new Error('boom')
      if (id === 'd') return undefined
      return { ok: true }
    })
    const res = await runBulkClear(['a', 'b', 'c', 'd', 'e'], { note: null, clearOne })
    expect(res).toEqual({ cleared: ['a', 'e'], failed: ['b', 'c', 'd'] })
    expect(clearOne).toHaveBeenCalledTimes(5)
  })

  it('does nothing for an empty list', async () => {
    const clearOne = vi.fn()
    expect(await runBulkClear([], { note: '', clearOne })).toEqual({ cleared: [], failed: [] })
    expect(clearOne).not.toHaveBeenCalled()
  })
})

// APPROVALSQ.5 — undoing a bulk clear is the same walk, one request at a time.
describe('runBulkUndo', () => {
  it('calls undoOne once per id, strictly in order and never in parallel', async () => {
    const log = []
    let active = 0
    let maxActive = 0
    const undoOne = vi.fn(async (id) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      log.push(`start-${id}`)
      await new Promise((r) => setTimeout(r, 1))
      log.push(`end-${id}`)
      active -= 1
      return { ok: true }
    })
    const res = await runBulkUndo(['a', 'b', 'c'], { undoOne })
    expect(maxActive).toBe(1)
    expect(log).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
    expect(res).toEqual({ restored: ['a', 'b', 'c'], failed: [] })
  })

  it('sorts a refusal, a throw and a non-ok into failed and keeps going', async () => {
    const undoOne = vi.fn(async (id) => {
      if (id === 'b') return { ok: false }
      if (id === 'c') throw new Error('network')
      return { ok: true }
    })
    const res = await runBulkUndo(['a', 'b', 'c', 'd'], { undoOne })
    expect(res).toEqual({ restored: ['a', 'd'], failed: ['b', 'c'] })
    expect(undoOne).toHaveBeenCalledTimes(4)
  })

  it('does nothing for no ids', async () => {
    const undoOne = vi.fn()
    expect(await runBulkUndo([], { undoOne })).toEqual({ restored: [], failed: [] })
    expect(undoOne).not.toHaveBeenCalled()
  })
})
