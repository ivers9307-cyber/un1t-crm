// FREQ-CAP.1 — unit tests for the cross-channel marketing frequency
// cap decision helpers (src/lib/frequency-cap.js). All pure except
// stampMarketingTouch, which is tested against a chainable fake.

import { describe, it, expect, vi } from 'vitest'
import {
  normalizeFrequencyCapSetting,
  frequencyCapFromLocationSettings,
  isFrequencyCapped,
  capWindowRemainingMs,
  frequencyCapDeferUntil,
  capCutoffIso,
  FrequencyCapDeferral,
  stampMarketingTouch,
  FREQUENCY_CAP_DEFAULT_HOURS,
  FREQUENCY_CAP_MIN_HOURS,
  FREQUENCY_CAP_MAX_HOURS,
} from './frequency-cap.js'

const NOW = new Date('2026-07-10T12:00:00.000Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60_000).toISOString()

describe('normalizeFrequencyCapSetting', () => {
  it('defaults to disabled + 24h for null/undefined/garbage', () => {
    for (const raw of [null, undefined, {}, 'nope', 42]) {
      expect(normalizeFrequencyCapSetting(raw)).toEqual({
        enabled: false,
        minHoursBetween: FREQUENCY_CAP_DEFAULT_HOURS,
      })
    }
  })

  it('only enabled === true enables (no truthy coercion)', () => {
    expect(normalizeFrequencyCapSetting({ enabled: 'yes' }).enabled).toBe(false)
    expect(normalizeFrequencyCapSetting({ enabled: 1 }).enabled).toBe(false)
    expect(normalizeFrequencyCapSetting({ enabled: true }).enabled).toBe(true)
  })

  it('clamps hours to the 1–168 bounds and rounds', () => {
    expect(normalizeFrequencyCapSetting({ min_hours_between: 0 }).minHoursBetween).toBe(FREQUENCY_CAP_MIN_HOURS)
    expect(normalizeFrequencyCapSetting({ min_hours_between: -5 }).minHoursBetween).toBe(FREQUENCY_CAP_MIN_HOURS)
    expect(normalizeFrequencyCapSetting({ min_hours_between: 9999 }).minHoursBetween).toBe(FREQUENCY_CAP_MAX_HOURS)
    expect(normalizeFrequencyCapSetting({ min_hours_between: 12.6 }).minHoursBetween).toBe(13)
    expect(normalizeFrequencyCapSetting({ min_hours_between: '48' }).minHoursBetween).toBe(48)
    expect(normalizeFrequencyCapSetting({ min_hours_between: 'abc' }).minHoursBetween).toBe(FREQUENCY_CAP_DEFAULT_HOURS)
  })
})

describe('frequencyCapFromLocationSettings', () => {
  it('reads settings.comms_frequency_cap', () => {
    const s = frequencyCapFromLocationSettings({
      glofox: { api_key: 'x' },
      comms_frequency_cap: { enabled: true, min_hours_between: 48 },
    })
    expect(s).toEqual({ enabled: true, minHoursBetween: 48 })
  })

  it('degrades to disabled when the key is absent (fail open)', () => {
    expect(frequencyCapFromLocationSettings(null).enabled).toBe(false)
    expect(frequencyCapFromLocationSettings({}).enabled).toBe(false)
  })
})

describe('isFrequencyCapped', () => {
  const enabled24 = { enabled: true, minHoursBetween: 24 }

  it('never capped when disabled, even with a fresh touch', () => {
    const contact = { last_marketing_touch_at: hoursAgo(1) }
    expect(isFrequencyCapped(contact, { enabled: false, minHoursBetween: 24 }, NOW)).toBe(false)
    expect(isFrequencyCapped(contact, null, NOW)).toBe(false)
    expect(isFrequencyCapped(contact, undefined, NOW)).toBe(false)
  })

  it('never capped with no touch history', () => {
    expect(isFrequencyCapped({}, enabled24, NOW)).toBe(false)
    expect(isFrequencyCapped({ last_marketing_touch_at: null }, enabled24, NOW)).toBe(false)
    expect(isFrequencyCapped(null, enabled24, NOW)).toBe(false)
  })

  it('capped inside the window, clear outside it', () => {
    expect(isFrequencyCapped({ last_marketing_touch_at: hoursAgo(23) }, enabled24, NOW)).toBe(true)
    expect(isFrequencyCapped({ last_marketing_touch_at: hoursAgo(25) }, enabled24, NOW)).toBe(false)
  })

  it('boundary: exactly minHoursBetween ago is NOT capped', () => {
    expect(isFrequencyCapped({ last_marketing_touch_at: hoursAgo(24) }, enabled24, NOW)).toBe(false)
  })

  it('unparseable timestamp fails open', () => {
    expect(isFrequencyCapped({ last_marketing_touch_at: 'not-a-date' }, enabled24, NOW)).toBe(false)
  })
})

describe('capWindowRemainingMs / frequencyCapDeferUntil', () => {
  const enabled24 = { enabled: true, minHoursBetween: 24 }

  it('remaining is window minus elapsed', () => {
    const contact = { last_marketing_touch_at: hoursAgo(20) }
    expect(capWindowRemainingMs(contact, enabled24, NOW)).toBe(4 * 60 * 60_000)
  })

  it('remaining is 0 when not capped', () => {
    expect(capWindowRemainingMs({ last_marketing_touch_at: hoursAgo(30) }, enabled24, NOW)).toBe(0)
    expect(capWindowRemainingMs({}, enabled24, NOW)).toBe(0)
  })

  it('deferUntil = now + remaining + jitter', () => {
    const contact = { last_marketing_touch_at: hoursAgo(20) }
    const iso = frequencyCapDeferUntil(contact, enabled24, NOW, 60_000)
    expect(iso).toBe(new Date(NOW.getTime() + 4 * 60 * 60_000 + 60_000).toISOString())
  })

  it('deferUntil default jitter stays within bounds', () => {
    const contact = { last_marketing_touch_at: hoursAgo(20) }
    const t = new Date(frequencyCapDeferUntil(contact, enabled24, NOW)).getTime()
    const base = NOW.getTime() + 4 * 60 * 60_000
    expect(t).toBeGreaterThanOrEqual(base)
    expect(t).toBeLessThan(base + 5 * 60_000)
  })
})

describe('capCutoffIso', () => {
  it('is now minus the window', () => {
    expect(capCutoffIso({ enabled: true, minHoursBetween: 24 }, NOW)).toBe(hoursAgo(24))
    expect(capCutoffIso({ enabled: true, minHoursBetween: 1 }, NOW)).toBe(hoursAgo(1))
  })
})

describe('FrequencyCapDeferral', () => {
  it('carries deferUntil and is instanceof Error', () => {
    const e = new FrequencyCapDeferral('2026-07-11T12:00:00.000Z')
    expect(e).toBeInstanceOf(Error)
    expect(e.deferUntil).toBe('2026-07-11T12:00:00.000Z')
    expect(e.name).toBe('FrequencyCapDeferral')
  })
})

describe('stampMarketingTouch', () => {
  function makeDb(routes = {}) {
    const updates = []
    return {
      updates,
      from(table) {
        const state = { table, ops: [] }
        const b = new Proxy({}, {
          get(_, method) {
            if (method === 'then') {
              updates.push(state)
              if (routes.fail) {
                const p = Promise.reject(new Error('boom'))
                return p.then.bind(p)
              }
              const p = Promise.resolve({})
              return p.then.bind(p)
            }
            return (...args) => { state.ops.push({ method, args }); return b }
          },
        })
        return b
      },
    }
  }

  it('updates last_marketing_touch_at for the given ids', async () => {
    const db = makeDb()
    await stampMarketingTouch(db, ['c1', 'c2'], '2026-07-10T12:00:00.000Z')
    expect(db.updates).toHaveLength(1)
    const st = db.updates[0]
    expect(st.table).toBe('contacts')
    expect(st.ops.find(o => o.method === 'update').args[0]).toEqual({
      last_marketing_touch_at: '2026-07-10T12:00:00.000Z',
    })
    expect(st.ops.find(o => o.method === 'in').args[1]).toEqual(['c1', 'c2'])
  })

  it('chunks large batches', async () => {
    const db = makeDb()
    await stampMarketingTouch(db, Array.from({ length: 450 }, (_, i) => `c${i}`))
    expect(db.updates).toHaveLength(3) // 200 + 200 + 50
  })

  it('no-ops on empty/nullish input', async () => {
    const db = makeDb()
    await stampMarketingTouch(db, [])
    await stampMarketingTouch(db, null)
    expect(db.updates).toHaveLength(0)
  })

  it('swallows failures (best-effort — never fails the send)', async () => {
    const db = makeDb({ fail: true })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(stampMarketingTouch(db, ['c1'])).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
