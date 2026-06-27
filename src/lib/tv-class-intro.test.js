import { describe, it, expect } from 'vitest'
import { shouldPlayIntro, INTRO_WINDOW_MS, INTRO_DURATION_MS } from './tv-class-intro.js'

const start = '2026-06-27T17:00:00Z'
const startMs = Date.parse(start)
const cls = { glofox_event_id: 'e1', class_name: 'TEMPO', starts_at: start }

describe('shouldPlayIntro', () => {
  it('plays right at the scheduled start (new occurrence)', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs + 1000 })).toBe(true)
  })
  it('does NOT play before the scheduled start', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs - 60_000 })).toBe(false)
  })
  it('does NOT play past the window (e.g. a mid-class page load)', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs + INTRO_WINDOW_MS + 1000 })).toBe(false)
  })
  it('does NOT replay for the same occurrence key', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: 'e1', nowMs: startMs + 1000 })).toBe(false)
  })
  it('plays again for a different occurrence key', () => {
    const next = { glofox_event_id: 'e2', class_name: 'RIDE', starts_at: start }
    expect(shouldPlayIntro({ currentClass: next, lastPlayedKey: 'e1', nowMs: startMs + 1000 })).toBe(true)
  })
  it('false for null / malformed current class', () => {
    expect(shouldPlayIntro({ currentClass: null, lastPlayedKey: null, nowMs: startMs })).toBe(false)
    expect(shouldPlayIntro({ currentClass: { glofox_event_id: 'e1' }, lastPlayedKey: null, nowMs: startMs })).toBe(false)
  })
  it('exposes sane constants', () => {
    expect(INTRO_WINDOW_MS).toBe(120_000)
    expect(INTRO_DURATION_MS).toBe(8_000)
  })
})
