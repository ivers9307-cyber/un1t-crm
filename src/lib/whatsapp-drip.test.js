// src/lib/whatsapp-drip.test.js
import { describe, it, expect } from 'vitest'
import {
  isWithinSendWindow, dripWindowStatus, rollingHeadroom, estimateDripDays, selectDripRecipients, dripOutcome,
  PER_TICK_MAX, AUTO_PAUSE_CONSECUTIVE_FAILURES,
} from './whatsapp-drip.js'

const DUBLIN = 'Europe/Dublin'
const win = { start: '09:00', end: '20:00', tz: DUBLIN }

describe('isWithinSendWindow', () => {
  it('is true at midday Dublin summer time', () => {
    // 12:00Z = 13:00 IST (BST) — inside 09:00–20:00
    expect(isWithinSendWindow(new Date('2026-06-10T12:00:00Z'), win)).toBe(true)
  })
  it('is false before the window opens (winter / GMT)', () => {
    // 08:30Z = 08:30 GMT in January — before 09:00
    expect(isWithinSendWindow(new Date('2026-01-10T08:30:00Z'), win)).toBe(false)
  })
  it('is false after the window closes', () => {
    // 21:00Z = 22:00 IST — after 20:00
    expect(isWithinSendWindow(new Date('2026-06-10T21:00:00Z'), win)).toBe(false)
  })
  it('respects DST: the same UTC wall-clock flips across the BST boundary', () => {
    // 19:30Z → 20:30 IST in summer (OUT), 19:30 GMT in winter (IN)
    expect(isWithinSendWindow(new Date('2026-06-10T19:30:00Z'), win)).toBe(false)
    expect(isWithinSendWindow(new Date('2026-01-10T19:30:00Z'), win)).toBe(true)
  })
  it('accepts HH:MM:SS times (Postgres `time` columns serialise that way)', () => {
    const w = { start: '09:00:00', end: '20:00:00', tz: DUBLIN }
    expect(isWithinSendWindow(new Date('2026-06-10T12:00:00Z'), w)).toBe(true)
  })
  it('a zero-length window never sends', () => {
    expect(isWithinSendWindow(new Date('2026-06-10T12:00:00Z'), { start: '09:00', end: '09:00', tz: DUBLIN })).toBe(false)
  })
})

describe('dripWindowStatus', () => {
  it('is sending inside the window when not paused', () => {
    // 12:00Z = 13:00 IST — inside 09:00–20:00
    expect(dripWindowStatus(new Date('2026-06-10T12:00:00Z'), win)).toEqual({ state: 'sending' })
  })
  it('is paused when paused, even inside the window', () => {
    expect(dripWindowStatus(new Date('2026-06-10T12:00:00Z'), { ...win, paused: true })).toEqual({ state: 'paused' })
  })
  it('is closed with the resume time outside the window', () => {
    // 21:00Z = 22:00 IST — past 20:00
    expect(dripWindowStatus(new Date('2026-06-10T21:00:00Z'), win)).toEqual({ state: 'closed', resumesAt: '09:00' })
  })
})

describe('rollingHeadroom', () => {
  it('returns the unused allowance', () => {
    expect(rollingHeadroom(500, 0)).toBe(500)
    expect(rollingHeadroom(500, 123)).toBe(377)
  })
  it('clamps to 0 when the cap is met or exceeded', () => {
    expect(rollingHeadroom(500, 500)).toBe(0)
    expect(rollingHeadroom(500, 600)).toBe(0)
  })
})

describe('estimateDripDays', () => {
  it('is 0 when nothing remains', () => {
    expect(estimateDripDays(0, 500)).toBe(0)
  })
  it('ceils remaining / dailyCap', () => {
    expect(estimateDripDays(500, 500)).toBe(1)
    expect(estimateDripDays(501, 500)).toBe(2)
    expect(estimateDripDays(1200, 500)).toBe(3)
  })
  it('is Infinity when the cap is non-positive', () => {
    expect(estimateDripDays(10, 0)).toBe(Infinity)
  })
})

describe('selectDripRecipients', () => {
  const aud = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, wa_phone: `+1${i}` }))

  it('sends the whole short audience and marks exhausted', () => {
    const r = selectDripRecipients({ audience: aud(5), doneIds: [], headroom: 100, perTickMax: 100 })
    expect(r.toSend).toHaveLength(5)
    expect(r.remainingCount).toBe(5)
    expect(r.exhausted).toBe(true)
  })
  it('caps at perTickMax and is not exhausted when more remain', () => {
    const r = selectDripRecipients({ audience: aud(250), doneIds: [], headroom: 500, perTickMax: 100 })
    expect(r.toSend).toHaveLength(100)
    expect(r.remainingCount).toBe(250)
    expect(r.exhausted).toBe(false)
  })
  it('excludes already-done contacts and exhausts on the last batch', () => {
    const audience = aud(250)
    const doneIds = audience.slice(0, 200).map(c => c.id) // 50 remain
    const r = selectDripRecipients({ audience, doneIds, headroom: 500, perTickMax: 100 })
    expect(r.toSend).toHaveLength(50)
    expect(r.exhausted).toBe(true)
  })
  it('caps at headroom when headroom < perTickMax', () => {
    const r = selectDripRecipients({ audience: aud(250), doneIds: [], headroom: 30, perTickMax: 100 })
    expect(r.toSend).toHaveLength(30)
    expect(r.exhausted).toBe(false)
  })
  it('sends nothing and is NOT exhausted when headroom is 0', () => {
    const r = selectDripRecipients({ audience: aud(250), doneIds: [], headroom: 0, perTickMax: 100 })
    expect(r.toSend).toHaveLength(0)
    expect(r.exhausted).toBe(false)
  })
  it('an empty audience is exhausted', () => {
    const r = selectDripRecipients({ audience: [], doneIds: [], headroom: 100, perTickMax: 100 })
    expect(r.toSend).toHaveLength(0)
    expect(r.exhausted).toBe(true)
  })

  // FREQ-CAP.1 — the isEligible predicate holds contacts out of THIS
  // tick without recording anything, and deferred contacts block
  // exhaustion so the drip stays open until they clear.
  describe('isEligible (frequency cap deferral)', () => {
    it('filters ineligible contacts out of toSend and reports deferred', () => {
      const audience = aud(5)
      const r = selectDripRecipients({
        audience, doneIds: [], headroom: 100, perTickMax: 100,
        isEligible: (c) => c.id !== 'c1' && c.id !== 'c3',
      })
      expect(r.toSend.map(c => c.id)).toEqual(['c0', 'c2', 'c4'])
      expect(r.deferred).toBe(2)
      expect(r.remainingCount).toBe(5)
    })
    it('deferred contacts block exhaustion (drip stays open)', () => {
      const r = selectDripRecipients({
        audience: aud(5), doneIds: [], headroom: 100, perTickMax: 100,
        isEligible: (c) => c.id !== 'c1',
      })
      expect(r.toSend).toHaveLength(4)
      expect(r.exhausted).toBe(false)
    })
    it('everyone deferred → empty batch, not exhausted', () => {
      const r = selectDripRecipients({
        audience: aud(3), doneIds: [], headroom: 100, perTickMax: 100,
        isEligible: () => false,
      })
      expect(r.toSend).toHaveLength(0)
      expect(r.deferred).toBe(3)
      expect(r.exhausted).toBe(false)
    })
    it('already-done contacts do not count as deferred', () => {
      const audience = aud(4)
      const r = selectDripRecipients({
        audience, doneIds: ['c0', 'c1'], headroom: 100, perTickMax: 100,
        isEligible: () => true,
      })
      expect(r.deferred).toBe(0)
      expect(r.exhausted).toBe(true)
    })
    it('default predicate keeps legacy behaviour (deferred 0, exhausted on last batch)', () => {
      const r = selectDripRecipients({ audience: aud(5), doneIds: [], headroom: 100, perTickMax: 100 })
      expect(r.deferred).toBe(0)
      expect(r.exhausted).toBe(true)
    })
  })
})

describe('dripOutcome', () => {
  const ISO = '2026-06-10T10:00:00.000Z'
  it('finalises to sent when exhausted', () => {
    expect(dripOutcome({ autoPaused: false, exhausted: true }, ISO)).toEqual({ status: 'sent', sent_at: ISO, paused_at: null })
  })
  it('stays sending mid-drip', () => {
    expect(dripOutcome({ autoPaused: false, exhausted: false }, ISO)).toEqual({ status: 'sending' })
  })
  it('pauses (stays sending + paused_at) on auto-pause', () => {
    expect(dripOutcome({ autoPaused: true, exhausted: false }, ISO)).toEqual({ status: 'sending', paused_at: ISO })
  })
  it('auto-pause beats exhaustion', () => {
    expect(dripOutcome({ autoPaused: true, exhausted: true }, ISO)).toEqual({ status: 'sending', paused_at: ISO })
  })
})

describe('constants', () => {
  it('are sane', () => {
    expect(PER_TICK_MAX).toBe(100)
    expect(AUTO_PAUSE_CONSECUTIVE_FAILURES).toBe(5)
  })
})
