import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { loadSafetyTimers, safetyTimersOn } from './safety-timers'
import { logWarn } from '@/lib/log'

beforeEach(() => vi.clearAllMocks())

// A one-table fake that records the chain and answers `result`.
function fakeDb(result) {
  const calls = []
  const chain = {
    select: (...a) => { calls.push(['select', ...a]); return chain },
    eq: (...a) => { calls.push(['eq', ...a]); return chain },
    maybeSingle: async () => (typeof result === 'function' ? result() : result),
  }
  return { calls, from: (t) => { calls.push(['from', t]); return chain } }
}

describe('safety-timer switch (SHELLYTIMERS.5)', () => {
  it('only an explicit JSON true is on', () => {
    expect(safetyTimersOn(true)).toBe(true)
    for (const v of [false, 'true', 1, null, undefined, {}]) expect(safetyTimersOn(v)).toBe(false)
  })

  it('reads ONE json path of the location row, scoped by id — never the settings column', async () => {
    const db = fakeDb({ data: { safety_timers: true }, error: null })
    expect(await loadSafetyTimers(db, 'loc-1')).toBe(true)
    expect(db.calls).toEqual([
      ['from', 'locations'],
      ['select', 'safety_timers:settings->shelly->safety_timers'],
      ['eq', 'id', 'loc-1'],
    ])
  })

  it('off for a missing key, a missing row, a failed read and a throw (logged, ids only)', async () => {
    expect(await loadSafetyTimers(fakeDb({ data: { safety_timers: null }, error: null }), 'l')).toBe(false)
    expect(await loadSafetyTimers(fakeDb({ data: null, error: null }), 'l')).toBe(false)
    expect(await loadSafetyTimers(fakeDb({ data: null, error: { message: 'pg down' } }), 'l')).toBe(false)
    expect(await loadSafetyTimers(fakeDb(() => { throw new Error('boom') }), 'l')).toBe(false)
    expect(logWarn).toHaveBeenCalledTimes(2)
    expect(logWarn.mock.calls[0][2]).toEqual({ locationId: 'l', error: 'pg down' })
    expect(await loadSafetyTimers(fakeDb({ data: { safety_timers: true }, error: null }), null)).toBe(false)
  })
})
