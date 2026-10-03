// C31 PUSHNITS.1 — live-class.js's three unchecked writes.
//
//   1. The achievement notified_at stamp ran BEFORE the session push, so a
//      push that reached nobody still marked the achievements "notified".
//      It now follows the push and runs only when the push reached a device.
//   2. endSession's strap_assignments close discarded its error.
//   3. pairOverride's patch of an existing open session (a mid-class strap
//      swap, a late class link) discarded its error.
//
// A supabase builder RESOLVES with { error } rather than throwing, so a
// try/catch around one never fires: each write's error is judged and logged.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/hr-post-class-email', () => ({ sendPostClassEmail: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/achievements', () => ({ runDetectionForSession: vi.fn() }))
vi.mock('@/lib/external-export', () => ({ enqueueExportsForSession: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { finalizeSessionRewards, endSession, pairOverride } from './live-class.js'
import { runDetectionForSession } from '@/lib/achievements'
import { sendCustomerPush } from '@/lib/customer-push'
import { logError } from '@/lib/log'

const BOOM = { code: 'XX000', message: 'write exploded' }

// A chainable fake: every filter returns the builder, awaiting it (or
// .single()/.maybeSingle()) resolves to whatever `answer(table, op, calls)`
// says. Every settled operation is recorded in `log`, in order.
function makeDb(answer) {
  const log = []
  const db = {
    log,
    from(table) {
      const b = { table, op: 'select', payload: null, calls: [] }
      const settle = () => {
        log.push({ table: b.table, op: b.op, payload: b.payload, calls: b.calls })
        return Promise.resolve(answer(b.table, b.op, b.calls, b.payload) ?? { data: null, error: null })
      }
      const proxy = new Proxy(b, {
        get(target, prop) {
          if (prop === 'then') return (res, rej) => settle().then(res, rej)
          if (prop === 'single' || prop === 'maybeSingle') return () => settle()
          if (['insert', 'update', 'upsert', 'delete'].includes(prop)) {
            return (payload) => { target.op = prop; target.payload = payload ?? null; return proxy }
          }
          if (prop in target) return target[prop]
          return (...args) => { target.calls.push([prop, ...args]); return proxy }
        },
      })
      return proxy
    },
  }
  return db
}

const SESSION = {
  id: 'sess-1', contact_id: 'c-1', location_id: 'loc-1', effort_points: 40,
  ended_at: '2026-06-20T06:00:00Z', source: 'participation', glofox_event_id: null,
  class_name: 'DR1VE', raw_metadata: null,
}

function rewardsDb({ stampError = null } = {}) {
  return makeDb((table, op) => {
    if (table === 'heart_rate_sessions' && op === 'select') return { data: SESSION, error: null }
    if (table === 'contact_achievements' && op === 'update') return { data: stampError ? null : [{ id: 'a-1' }], error: stampError }
    if (table === 'contact_goals') return { data: [], error: null }
    if (table === 'locations') return { data: { id: 'loc-1', settings: {} }, error: null }
    return { data: null, error: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  runDetectionForSession.mockResolvedValue({ ok: true, unlocked: [{ slug: 'first-class' }] })
})

describe('finalizeSessionRewards — the achievement stamp follows the push', () => {
  it('stamps notified_at AFTER a push that reached a device', async () => {
    const db = rewardsDb()
    const order = []
    sendCustomerPush.mockImplementation(async () => { order.push('push'); return { sent: 1, failed: 0, invalidated: 0, skipped: 0 } })
    const realFrom = db.from
    db.from = (t) => { if (t === 'contact_achievements') order.push('stamp'); return realFrom(t) }

    await finalizeSessionRewards(db, 'sess-1')

    expect(order).toEqual(['push', 'stamp'])
    const stamp = db.log.find((l) => l.table === 'contact_achievements')
    expect(stamp.op).toBe('update')
    expect(stamp.payload.notified_at).toEqual(expect.any(String))
    expect(stamp.calls).toContainEqual(['eq', 'source_session_id', 'sess-1'])
    expect(stamp.calls).toContainEqual(['is', 'notified_at', null])
  })

  it('does NOT stamp when the push reached nobody (failed or no device)', async () => {
    for (const result of [{ sent: 0, failed: 1, invalidated: 0, skipped: 0 }, { sent: 0, failed: 0, invalidated: 0, skipped: 0 }, null]) {
      const db = rewardsDb()
      sendCustomerPush.mockResolvedValueOnce(result)
      await finalizeSessionRewards(db, 'sess-1')
      expect(db.log.filter((l) => l.table === 'contact_achievements')).toEqual([])
    }
  })

  it('a failed stamp write is logged, never silent', async () => {
    const db = rewardsDb({ stampError: BOOM })
    sendCustomerPush.mockResolvedValue({ sent: 1, failed: 0, invalidated: 0, skipped: 0 })
    await finalizeSessionRewards(db, 'sess-1')
    expect(logError).toHaveBeenCalledWith('live-class', expect.stringMatching(/notified_at/), expect.objectContaining({ sessionId: 'sess-1' }))
  })
})

describe('endSession — the strap_assignments close', () => {
  it('a failed close is logged; the finalised session still answers ok', async () => {
    const db = makeDb((table, op) => {
      if (table === 'heart_rate_sessions' && op === 'select') {
        return { data: { id: 'sess-2', contact_id: null, location_id: 'loc-1', max_hr_used: 190, ended_at: null }, error: null }
      }
      if (table === 'heart_rate_sessions' && op === 'update') return { data: null, error: null }
      if (table === 'locations') return { data: { id: 'loc-1', settings: {} }, error: null }
      if (table === 'hr_samples') return { data: [{ recorded_at: '2026-06-20T05:30:00Z', bpm: 150 }], error: null }
      if (table === 'strap_assignments' && op === 'update') return { data: null, error: BOOM }
      return { data: null, error: null }
    })
    const out = await endSession(db, 'sess-2')
    expect(out.ok).toBe(true)
    expect(logError).toHaveBeenCalledWith('live-class', expect.stringMatching(/strap_assignments/), expect.objectContaining({ sessionId: 'sess-2' }))
  })
})

describe('pairOverride — the existing-session patch', () => {
  it('a failed patch (strap swap) is logged; the pairing itself still stands', async () => {
    const db = makeDb((table, op) => {
      if (table === 'contacts') return { data: { id: 'c-1', max_hr_override: null, dob: '1990-05-08', location_id: 'loc-1' }, error: null }
      if (table === 'class_occurrences') return { data: [], error: null }
      if (table === 'heart_rate_sessions' && op === 'select') {
        return { data: { id: 'sess-open', device_identifier: 'ble:OLD', glofox_event_id: 'ev-1' }, error: null }
      }
      if (table === 'heart_rate_sessions' && op === 'update') return { data: null, error: BOOM }
      if (table === 'contact_devices' && op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    })
    const out = await pairOverride(db, { locationId: 'loc-1', bridgeId: 'b-1', contactId: 'c-1', deviceKey: 'ble:NEW' })
    expect(out.ok).toBe(true)
    expect(out.sessionId).toBe('sess-open')
    expect(db.log.find((l) => l.table === 'strap_assignments' && l.op === 'insert')).toBeTruthy()
    expect(logError).toHaveBeenCalledWith('live-class', expect.stringMatching(/patch/), expect.objectContaining({ sessionId: 'sess-open' }))
  })
})
