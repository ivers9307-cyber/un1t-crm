import { describe, it, expect } from 'vitest'
import { describeGroupNow } from './group-now'

const NOW = Date.parse('2026-08-24T12:00:00.000Z')
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const group = (over = {}) => ({ id: 'g1', enabled: true, schedule_mode: 'fixed', override: null, ...over })
const on = { last_state: { output: true } }
const off = { last_state: { output: false } }
const unknown = { last_state: null }

describe('describeGroupNow', () => {
  it('counts members whose last reading says on — unknown is not on', () => {
    const r = describeGroupNow(group(), [on, off, unknown], [], NOW)
    expect(r).toMatchObject({ on_count: 1, member_count: 3 })
  })

  it('a live override wins, with its until', () => {
    const until = iso(NOW + 60 * MIN)
    const r = describeGroupNow(group({ override: { state: 'on', until, set_at: iso(NOW) } }), [on], [{ on_at: NOW - MIN, off_at: NOW + MIN }], NOW)
    expect(r).toEqual({ on_count: 1, member_count: 1, mode: 'override', until, next_on: null })
  })

  it('an expired override falls through to the schedule', () => {
    const r = describeGroupNow(group({ override: { state: 'on', until: iso(NOW - MIN), set_at: 'x' } }), [], [], NOW)
    expect(r.mode).toBe('idle')
  })

  it('a live override holds even on a group with no schedule', () => {
    const until = iso(NOW + MIN)
    const r = describeGroupNow(group({ enabled: false, schedule_mode: 'none', override: { state: 'off', until, set_at: 'x' } }), [], null, NOW)
    expect(r).toMatchObject({ mode: 'override', until })
  })

  it('disabled or scheduleless is none', () => {
    expect(describeGroupNow(group({ enabled: false }), [], [], NOW).mode).toBe('none')
    expect(describeGroupNow(group({ schedule_mode: 'none' }), [], [], NOW).mode).toBe('none')
    expect(describeGroupNow(group({ schedule_mode: 'none' }), [], [], NOW)).toMatchObject({ until: null, next_on: null })
  })

  it('inside a window is window, until its off_at (on_at inclusive, off_at exclusive)', () => {
    const w = { on_at: NOW, off_at: NOW + 30 * MIN }
    expect(describeGroupNow(group(), [], [w], NOW)).toMatchObject({ mode: 'window', until: iso(NOW + 30 * MIN), next_on: null })
    expect(describeGroupNow(group(), [], [{ on_at: NOW - 30 * MIN, off_at: NOW }], NOW).mode).toBe('idle')
  })

  it('between windows is idle, with the next on_at later today', () => {
    const r = describeGroupNow(group({ schedule_mode: 'class' }), [], [
      { on_at: NOW - 120 * MIN, off_at: NOW - 60 * MIN },
      { on_at: NOW + 90 * MIN, off_at: NOW + 150 * MIN },
      { on_at: NOW + 30 * MIN, off_at: NOW + 60 * MIN },
    ], NOW)
    expect(r).toEqual({ on_count: 0, member_count: 0, mode: 'idle', until: null, next_on: iso(NOW + 30 * MIN) })
  })

  it('idle with nothing left today has no next_on', () => {
    expect(describeGroupNow(group(), [], [{ on_at: NOW - 60 * MIN, off_at: NOW - 30 * MIN }], NOW)).toMatchObject({ mode: 'idle', next_on: null })
  })

  it('unread windows (null) are idle with no times, and say so', () => {
    expect(describeGroupNow(group({ schedule_mode: 'class' }), [], null, NOW)).toEqual({
      on_count: 0, member_count: 0, mode: 'idle', until: null, next_on: null, windows_unread: true,
    })
  })

  it('tolerates a missing member list and junk rows', () => {
    expect(describeGroupNow(group(), undefined, [], NOW)).toMatchObject({ on_count: 0, member_count: 0 })
    expect(describeGroupNow(group(), [null, { last_state: { output: 'true' } }], [], NOW)).toMatchObject({ on_count: 0, member_count: 2 })
  })
})
