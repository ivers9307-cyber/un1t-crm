// SCREENMODE.9 — how often the cast page polls for a push.
import { describe, it, expect } from 'vitest'
import { CAST_POLL_MS, CAST_KIOSK_POLL_MS, isKioskParam, castPollMs } from './tv-cast-poll.js'

describe('tv-cast-poll', () => {
  it('exports the two intervals', () => {
    expect(CAST_POLL_MS).toBe(6000)
    expect(CAST_KIOSK_POLL_MS).toBe(60_000)
  })

  it('kiosk slows the poll to 60 s and anything else keeps 6 s', () => {
    expect(castPollMs(true)).toBe(60_000)
    expect(castPollMs(false)).toBe(6000)
  })

  it('only the exact string "1" is the kiosk flag', () => {
    expect(isKioskParam('1')).toBe(true)
    expect(isKioskParam('true')).toBe(false)
    expect(isKioskParam(undefined)).toBe(false)
    expect(isKioskParam(1)).toBe(false)
    expect(isKioskParam(['1'])).toBe(false)
  })
})
