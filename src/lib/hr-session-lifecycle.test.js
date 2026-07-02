import { describe, it, expect } from 'vitest'
import {
  classSessionAction,
  shouldCloseStaleSession,
  shouldCloseSupersededSession,
  CLASS_END_GRACE_MS,
  STALE_AFTER_MS,
  MAX_SESSION_LENGTH_MS,
} from './hr-session-lifecycle.js'

const occ = { ends_at: '2026-06-27T09:00:00Z' }
const duringClass = Date.parse('2026-06-27T08:30:00Z')
const justAfter = Date.parse('2026-06-27T09:05:00Z')   // within +10m grace
const wellAfter = Date.parse('2026-06-27T09:30:00Z')   // past +10m grace

describe('classSessionAction', () => {
  it('creates when there is no prior session', () => {
    expect(classSessionAction({ existing: null, occ, nowMs: duringClass })).toBe('create')
  })
  it('returns an already-open session (rejoin)', () => {
    expect(classSessionAction({ existing: { id: 's', ended_at: null }, occ, nowMs: duringClass })).toBe('return')
  })
  it('reopens a closed session while the class is still live', () => {
    expect(classSessionAction({ existing: { id: 's', ended_at: '2026-06-27T08:36:00Z' }, occ, nowMs: justAfter })).toBe('reopen')
  })
  it('skips (no new session) when the class has ended', () => {
    expect(classSessionAction({ existing: { id: 's', ended_at: '2026-06-27T08:36:00Z' }, occ, nowMs: wellAfter })).toBe('skip')
  })
})

describe('shouldCloseStaleSession', () => {
  const base = { started_at: '2026-06-27T08:00:00Z' }
  const silentMin = (m) => new Date(duringClass - m * 60000).toISOString()

  it('keeps a class session open while silent but the class is still live', () => {
    const s = { ...base, glofox_event_id: 'e', last_sample_at: silentMin(10) }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: duringClass })).toBe(false)
  })
  it('closes a class session once silent AND the class has ended + grace', () => {
    const s = { ...base, glofox_event_id: 'e', last_sample_at: '2026-06-27T08:30:00Z' }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: wellAfter })).toBe(true)
  })
  it('does not close a still-streaming class session past scheduled end', () => {
    const s = { ...base, glofox_event_id: 'e', last_sample_at: new Date(wellAfter - 10000).toISOString() }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: wellAfter })).toBe(false)
  })
  it('closes a non-class session on 5-min silence (unchanged)', () => {
    const s = { ...base, glofox_event_id: null, last_sample_at: silentMin(6) }
    expect(shouldCloseStaleSession({ session: s, occ: null, nowMs: duringClass })).toBe(true)
  })
  it('closes any session past the 4h backstop regardless of silence', () => {
    const s = { started_at: new Date(duringClass - 5 * 3600_000).toISOString(), glofox_event_id: 'e', last_sample_at: new Date(duringClass - 10000).toISOString() }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: duringClass })).toBe(true)
  })

  // Item 4a — a strap that NEVER delivered a sample.
  it('closes a never-sampled non-class session open past staleMs', () => {
    const s = { started_at: silentMin(6), glofox_event_id: null, last_sample_at: null }
    expect(shouldCloseStaleSession({ session: s, occ: null, nowMs: duringClass })).toBe(true)
  })
  it('keeps a never-sampled session that is still within staleMs', () => {
    const s = { started_at: silentMin(2), glofox_event_id: null, last_sample_at: null }
    expect(shouldCloseStaleSession({ session: s, occ: null, nowMs: duringClass })).toBe(false)
  })
  it('defers a never-sampled class session while the class is still live', () => {
    const s = { started_at: silentMin(10), glofox_event_id: 'e', last_sample_at: null }
    expect(shouldCloseStaleSession({ session: s, occ, nowMs: duringClass })).toBe(false)
  })
})

// Item 1 — back-to-back classes: supersede a stale open session.
describe('shouldCloseSupersededSession', () => {
  const nowMs = Date.parse('2026-06-27T10:05:00Z')

  it('does not close when no new class is resolved', () => {
    expect(shouldCloseSupersededSession({ openEventId: 'e9', newEventId: null, openClassEndsAt: '2026-06-27T09:00:00Z', nowMs })).toBe(false)
  })
  it('does not close when the open session is not class-linked', () => {
    expect(shouldCloseSupersededSession({ openEventId: null, newEventId: 'e10', openClassEndsAt: null, nowMs })).toBe(false)
  })
  it('does not close when the open session is the SAME class (rejoin)', () => {
    expect(shouldCloseSupersededSession({ openEventId: 'e10', newEventId: 'e10', openClassEndsAt: '2026-06-27T09:00:00Z', nowMs })).toBe(false)
  })
  it('does not close a DIFFERENT class that has not yet ended past grace', () => {
    // 09:00 class ends 10:00; now 10:05 is within +10m grace → still keep.
    expect(shouldCloseSupersededSession({ openEventId: 'e9', newEventId: 'e10', openClassEndsAt: '2026-06-27T10:00:00Z', nowMs })).toBe(false)
  })
  it('closes a DIFFERENT class that ended past grace', () => {
    // 09:00 class ended 09:00; now 10:05 is well past +10m grace → supersede.
    expect(shouldCloseSupersededSession({ openEventId: 'e9', newEventId: 'e10', openClassEndsAt: '2026-06-27T09:00:00Z', nowMs })).toBe(true)
  })
  it('closes a DIFFERENT class with an unknown end (treated as ended)', () => {
    expect(shouldCloseSupersededSession({ openEventId: 'e9', newEventId: 'e10', openClassEndsAt: null, nowMs })).toBe(true)
  })
})
