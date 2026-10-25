import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/fleet-doorbell', () => ({ pingDevice: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { ringScreens, ringScreensForDisplay } from './screen-doorbell.js'
import { pingDevice } from '@/lib/fleet-doorbell'
import { logWarn } from '@/lib/log'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ringScreens', () => {
  it('pings each name in order, one at a time, and counts the ones that sent', async () => {
    const order = []
    let inFlight = 0
    let maxInFlight = 0
    pingDevice.mockImplementation(async (name) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(name)
      await Promise.resolve()
      inFlight -= 1
      return name !== 'hatch-screen2'
    })
    const sent = await ringScreens(['hatch-screen1', 'hatch-screen2', 'hatch-screen3'])
    expect(sent).toBe(2)
    expect(order).toEqual(['hatch-screen1', 'hatch-screen2', 'hatch-screen3'])
    expect(maxInFlight).toBe(1)
  })

  it('returns 0 and pings nothing for an empty or missing list', async () => {
    expect(await ringScreens([])).toBe(0)
    expect(await ringScreens(undefined)).toBe(0)
    expect(pingDevice).not.toHaveBeenCalled()
  })

  it('never throws: a ping that rejects counts as not sent and the rest still ring', async () => {
    pingDevice.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true)
    await expect(ringScreens(['a', 'b'])).resolves.toBe(1)
    expect(pingDevice).toHaveBeenCalledTimes(2)
  })
})

// A recording fake of db.from('fleet_devices').select().eq().eq().
function fakeDb({ rows = [], error = null } = {}) {
  const calls = { table: null, columns: null, eq: [] }
  const q = {
    select: (cols) => { calls.columns = cols; return q },
    eq: (col, val) => { calls.eq.push([col, val]); return q },
    then: (resolve) => resolve({ data: error ? null : rows, error }),
  }
  return { calls, db: { from: (t) => { calls.table = t; return q } } }
}

describe('ringScreensForDisplay', () => {
  it('reads the screens linked to the display and rings their device names', async () => {
    pingDevice.mockResolvedValue(true)
    const { db, calls } = fakeDb({ rows: [{ device_name: 'hatch-screen1' }, { device_name: 'hatch-screen2' }] })
    const sent = await ringScreensForDisplay(db, 'disp-1')
    expect(sent).toBe(2)
    expect(calls.table).toBe('fleet_devices')
    expect(calls.columns).toBe('device_name')
    expect(calls.eq).toEqual([['tv_display_id', 'disp-1'], ['role', 'screen']])
    expect(pingDevice.mock.calls.map((c) => c[0])).toEqual(['hatch-screen1', 'hatch-screen2'])
  })

  it('returns 0 and rings nothing when no screen is linked', async () => {
    const { db } = fakeDb({ rows: [] })
    expect(await ringScreensForDisplay(db, 'disp-1')).toBe(0)
    expect(pingDevice).not.toHaveBeenCalled()
  })

  it('logs a warning and returns 0 on a read error, never throwing', async () => {
    const { db } = fakeDb({ error: { message: 'relation exploded' } })
    await expect(ringScreensForDisplay(db, 'disp-1')).resolves.toBe(0)
    expect(pingDevice).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][0]).toBe('screen-doorbell')
  })
})
