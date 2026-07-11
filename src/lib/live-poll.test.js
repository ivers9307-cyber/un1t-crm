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
  it('polls fast while active', () => {
    expect(nextPollDelay({ sessions: [{ id: 'a' }] })).toBe(ACTIVE_POLL_MS)
  })
  it('backs off when idle', () => {
    expect(nextPollDelay({ sessions: [], available_straps: [] })).toBe(IDLE_POLL_MS)
  })
})
