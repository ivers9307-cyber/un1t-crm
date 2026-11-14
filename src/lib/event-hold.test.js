import { describe, it, expect } from 'vitest'
import { resolveEventHoldMinutes, loadEventHoldMinutes, EVENT_HOLD_KEY, DEFAULT_EVENT_HOLD_MINUTES } from './event-hold'

function makeDb({ row = null, error = null } = {}) {
  const calls = []
  const self = { maybeSingle: () => Promise.resolve({ data: error ? null : row, error }) }
  for (const m of ['select', 'eq']) self[m] = (...a) => { calls.push([m, a]); return self }
  return { calls, from: (t) => { calls.push(['from', [t]]); return self } }
}

describe('resolveEventHoldMinutes', () => {
  it('takes a whole number of minutes between 15 and a day', () => {
    expect(resolveEventHoldMinutes({ hold_minutes: 180 })).toBe(180)
    expect(resolveEventHoldMinutes({ hold_minutes: '90' })).toBe(90)
  })

  it('falls back to the default for anything else', () => {
    for (const config of [null, {}, { hold_minutes: 5 }, { hold_minutes: 5000 }, { hold_minutes: 90.5 }, { hold_minutes: 'soon' }]) {
      expect(resolveEventHoldMinutes(config)).toBe(DEFAULT_EVENT_HOLD_MINUTES)
    }
    expect(DEFAULT_EVENT_HOLD_MINUTES).toBe(120)
  })
})

describe('loadEventHoldMinutes', () => {
  it('reads the studio row for the event_hold key', async () => {
    const db = makeDb({ row: { config: { hold_minutes: 180 } } })
    expect(await loadEventHoldMinutes(db, 'loc-A')).toEqual({ ok: true, minutes: 180 })
    expect(db.calls).toContainEqual(['from', ['location_automations']])
    expect(db.calls).toContainEqual(['eq', ['location_id', 'loc-A']])
    expect(db.calls).toContainEqual(['eq', ['automation_key', EVENT_HOLD_KEY]])
  })

  it('a studio with no row uses the default', async () => {
    expect(await loadEventHoldMinutes(makeDb(), 'loc-A')).toEqual({ ok: true, minutes: 120 })
  })

  it('a failed read is a failure, never the default', async () => {
    expect(await loadEventHoldMinutes(makeDb({ error: { message: 'pg down' } }), 'loc-A')).toEqual({ ok: false, error: 'pg down' })
  })
})
