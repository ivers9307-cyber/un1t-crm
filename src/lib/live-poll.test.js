import { describe, it, expect } from 'vitest'
import { boardIsActive, nextPollDelay, ACTIVE_POLL_MS, IDLE_POLL_MS } from './live-poll'

describe('boardIsActive', () => {
  it('treats an unknown/null payload as active (never idle before we know)', () => {
    expect(boardIsActive(null)).toBe(true)
    expect(boardIsActive(undefined)).toBe(true)
  })

  it('is idle when nothing is live', () => {
    const idle = { sessions: [], available_straps: [], timer: null, current_class: null, occurrence: null }
    expect(boardIsActive(idle)).toBe(false)
  })

  it('is active with an open HR session', () => {
    expect(boardIsActive({ sessions: [{ id: 'a' }], available_straps: [] })).toBe(true)
  })

  it('is active when a strap is broadcasting (pre-class setup)', () => {
    expect(boardIsActive({ sessions: [], available_straps: [{ label: 'ant:1' }] })).toBe(true)
  })

  it('is active when a class timer is running (TV payload)', () => {
    expect(boardIsActive({ sessions: [], available_straps: [], timer: { id: 't' } })).toBe(true)
  })

  it('is active when a class is live (TV `current_class`)', () => {
    expect(boardIsActive({ sessions: [], available_straps: [], current_class: { class_name: 'WOD' } })).toBe(true)
  })

  it('is active when the coach view has an occurrence', () => {
    expect(boardIsActive({ sessions: [], available_straps: [], occurrence: { id: 'o' } })).toBe(true)
  })

  it('does not treat a non-empty roster alone as active (roster can outlive a class)', () => {
    expect(boardIsActive({ sessions: [], available_straps: [], roster: [{ id: 'r' }], occurrence: null })).toBe(false)
  })
})

describe('nextPollDelay', () => {
  // Fixed instants — Dublin is UTC+1 (IST) in July, UTC+0 (GMT) in January.
  const daytime = new Date('2026-07-01T12:00:00Z')     // 13:00 Dublin
  const overnight = new Date('2026-07-01T02:00:00Z')   // 03:00 Dublin
  const lateEvening = new Date('2026-01-15T22:30:00Z') // 22:30 Dublin (GMT)
  const earlyMorning = new Date('2026-07-01T05:30:00Z') // 06:30 Dublin (IST)

  it('polls fast while active, day or night', () => {
    expect(nextPollDelay({ sessions: [{ id: 'a' }] }, daytime)).toBe(ACTIVE_POLL_MS)
    expect(nextPollDelay({ sessions: [{ id: 'a' }] }, overnight)).toBe(ACTIVE_POLL_MS)
  })

  // TV-POLL-FAST.1 — the 30s idle back-off made a timer start take up to 30s
  // to reach the TV during the day. Idle now only backs off overnight.
  it('keeps the fast cadence when idle during opening hours', () => {
    expect(nextPollDelay({ sessions: [], available_straps: [] }, daytime)).toBe(ACTIVE_POLL_MS)
    expect(nextPollDelay({ sessions: [], available_straps: [] }, earlyMorning)).toBe(ACTIVE_POLL_MS)
  })

  it('backs off when idle overnight (Dublin wall-clock, DST-aware)', () => {
    expect(nextPollDelay({ sessions: [], available_straps: [] }, overnight)).toBe(IDLE_POLL_MS)
    expect(nextPollDelay({ sessions: [], available_straps: [] }, lateEvening)).toBe(IDLE_POLL_MS)
  })
})
