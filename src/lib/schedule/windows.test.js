import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  findWindowOverlap, WindowBase, NOT_SAME_BOUNDARY, windowsOverlapIssue,
  toMinutes, HHMM, DAY_LABELS, BASE_WINDOW,
} from './windows'

// SONOS.12 — planAction resolves an overlapping pair of windows
// earliest-starting-wins (windows is sorted ascending by on_at, then
// .find() returns the first match), so an unrejected overlap leaves the
// later/nested window silently dead: no error, no log line, nothing an
// operator could use to work out why it never fires. These tests exercise
// findWindowOverlap directly — the pure predicate SchedulePayload refines
// the `windows` array on — plus a couple of tests on the schema itself to
// prove the wiring (superRefine -> addIssue -> safeParse) actually holds.
//
// SHELLY-UI.1 moved this block here with the code it tests. The
// SchedulePayload wiring tests stayed behind in
// src/app/api/sonos/schedules/route.test.js — they pin the Sonos route's
// own composition, which is exactly what could silently unwire.
describe('findWindowOverlap', () => {
  it('passes non-overlapping windows on the same day', () => {
    const windows = [
      { days: [1], on: '06:00', off: '09:00' },
      { days: [1], on: '10:00', off: '12:00' },
    ]
    expect(findWindowOverlap(windows)).toBeNull()
  })

  it('fails overlapping windows on a shared day', () => {
    const a = { days: [1], on: '06:00', off: '21:30' }
    const b = { days: [1], on: '10:00', off: '12:00' }
    expect(findWindowOverlap([a, b])).toEqual([a, b])
  })

  it('never clashes windows on disjoint days, even at identical times', () => {
    const windows = [
      { days: [1], on: '10:00', off: '12:00' },
      { days: [2], on: '10:00', off: '12:00' },
    ]
    expect(findWindowOverlap(windows)).toBeNull()
  })

  it('catches an overnight window overlapping an early-morning one on the same day', () => {
    // 22:00-02:00 occupies the clock's late segment AND the early segment
    // of any day it's pinned to (the tail of "yesterday's" run lands
    // exactly there) — so it clashes with a 01:00-03:00 window pinned to
    // that same day, even though neither boundary literally coincides.
    const a = { days: [6], on: '22:00', off: '02:00' }
    const b = { days: [6], on: '01:00', off: '03:00' }
    expect(findWindowOverlap([a, b])).toEqual([a, b])
  })

  it('passes a single window', () => {
    const windows = [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:30' }]
    expect(findWindowOverlap(windows)).toBeNull()
  })

  it('passes an empty array', () => {
    expect(findWindowOverlap([])).toBeNull()
  })

  it('treats touching boundaries as adjacent, not overlapping', () => {
    // Matches planAction's own half-open `nowMs < off_at` check — back-
    // to-back windows are a normal, intentional handover, not a clash.
    const windows = [
      { days: [3], on: '06:00', off: '10:00' },
      { days: [3], on: '10:00', off: '12:00' },
    ]
    expect(findWindowOverlap(windows)).toBeNull()
  })

  it('flags a clash on any one shared day even when the rest of each days list differs', () => {
    const a = { days: [1, 3, 5], on: '06:00', off: '09:00' }
    const b = { days: [3], on: '07:00', off: '08:00' }
    expect(findWindowOverlap([a, b])).toEqual([a, b])
  })
})

// SHELLY-UI.1 — the shared pieces the two device families compose. These
// are what makes one implementation possible, so each is pinned on its own
// rather than only through a caller's schema.
describe('WindowBase', () => {
  it('accepts a well-formed window', () => {
    expect(WindowBase.safeParse({ days: [1, 5], on: '06:00', off: '21:30' }).success).toBe(true)
  })

  it('rejects an out-of-range day, an empty days list and a non-HH:MM time', () => {
    expect(WindowBase.safeParse({ days: [0], on: '06:00', off: '07:00' }).success).toBe(false)
    expect(WindowBase.safeParse({ days: [8], on: '06:00', off: '07:00' }).success).toBe(false)
    expect(WindowBase.safeParse({ days: [], on: '06:00', off: '07:00' }).success).toBe(false)
    expect(WindowBase.safeParse({ days: [1], on: '24:00', off: '07:00' }).success).toBe(false)
    expect(WindowBase.safeParse({ days: [1], on: '6:00', off: '07:00' }).success).toBe(false)
    expect(WindowBase.safeParse({ days: [1], on: '06:60', off: '07:00' }).success).toBe(false)
    expect(WindowBase.safeParse({ days: [1.5], on: '06:00', off: '07:00' }).success).toBe(false)
  })

  it('carries NO refine, so it can still be .extend()ed', () => {
    // This is the whole reason the same-boundary rule ships as a predicate
    // instead of being attached here: a refined object is a ZodEffects and
    // has no .extend(), which would make the Sonos volume/favourite schema
    // impossible to build from the shared base.
    expect(typeof WindowBase.extend).toBe('function')
    const Extended = WindowBase.extend({ volume: z.number().int().min(0).max(100) })
    expect(Extended.safeParse({ days: [1], on: '06:00', off: '07:00', volume: 30 }).success).toBe(true)
    // …and it accepts equal boundaries, because nothing here refuses them.
    expect(WindowBase.safeParse({ days: [1], on: '06:00', off: '06:00' }).success).toBe(true)
  })
})

describe('NOT_SAME_BOUNDARY', () => {
  it('rejects only the equal-boundary window', () => {
    expect(NOT_SAME_BOUNDARY.check({ on: '06:00', off: '06:00' })).toBe(false)
    expect(NOT_SAME_BOUNDARY.check({ on: '06:00', off: '06:01' })).toBe(true)
    // Overnight is legitimate — off before on is a wrap, not a mistake.
    expect(NOT_SAME_BOUNDARY.check({ on: '22:00', off: '02:00' })).toBe(true)
  })

  it('carries the message the operator sees, so callers never re-type it', () => {
    expect(NOT_SAME_BOUNDARY.message).toBe('A window must not start and end at the same time')
  })

  it('composes as the last step after .extend()', () => {
    const Window = WindowBase.extend({ volume: z.number().int().min(0).max(100) })
      .refine(NOT_SAME_BOUNDARY.check, { message: NOT_SAME_BOUNDARY.message })
    const parsed = Window.safeParse({ days: [1], on: '06:00', off: '06:00', volume: 30 })
    expect(parsed.success).toBe(false)
    expect(parsed.error.issues[0].message).toBe(NOT_SAME_BOUNDARY.message)
  })
})

describe('windowsOverlapIssue', () => {
  const Windows = z.array(WindowBase).max(16).superRefine(windowsOverlapIssue)

  it('names both windows by time when they clash', () => {
    const parsed = Windows.safeParse([
      { days: [1], on: '06:00', off: '21:30' },
      { days: [1], on: '10:00', off: '12:00' },
    ])
    expect(parsed.success).toBe(false)
    expect(parsed.error.issues[0].message).toBe(
      'Windows overlap on the same day: 06:00-21:30 and 10:00-12:00',
    )
  })

  it('passes windows that do not clash', () => {
    const parsed = Windows.safeParse([
      { days: [1], on: '06:00', off: '09:00' },
      { days: [1], on: '10:00', off: '12:00' },
    ])
    expect(parsed.success).toBe(true)
  })

  it('adds no issue at all when there is no clash', () => {
    // Called directly rather than through zod, so a stray addIssue on the
    // happy path can't hide behind a passing safeParse.
    const added = []
    windowsOverlapIssue([{ days: [1], on: '06:00', off: '09:00' }], { addIssue: (i) => added.push(i) })
    expect(added).toEqual([])
  })
})

// SHELLY-UI.1b — the remaining exports. toMinutes and HHMM are exported
// because Shelly's schemas and its energy/plan code read the same clock
// vocabulary; DAY_LABELS and BASE_WINDOW live here rather than in the
// 'use client' editor so a Server Component can import them as real values.
describe('toMinutes', () => {
  it('converts a valid HH:MM to minutes past midnight', () => {
    expect(toMinutes('00:00')).toBe(0)
    expect(toMinutes('09:30')).toBe(570)
    expect(toMinutes('23:59')).toBe(1439)
  })

  it('returns null for anything HHMM refuses, rather than a wrong number', () => {
    // The point of validating with .test() before splitting: '24:00' and
    // '9:30' would both parse arithmetically and silently produce a time
    // the engine would then act on.
    for (const bad of ['24:00', '9:30', '06:60', '', null, undefined, '0930', 'nope', '06:00:00']) {
      expect(toMinutes(bad)).toBeNull()
    }
  })

  it('agrees with HHMM about what is valid', () => {
    for (const s of ['00:00', '09:30', '23:59']) expect(HHMM.test(s)).toBe(true)
    for (const s of ['24:00', '9:30', '06:60']) expect(HHMM.test(s)).toBe(false)
  })
})

describe('DAY_LABELS', () => {
  it('is Mon..Sun numbered 1..7, inside WindowBase\'s own days bound', () => {
    expect(DAY_LABELS.map((d) => d.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(DAY_LABELS.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    const allDays = WindowBase.safeParse({ days: DAY_LABELS.map((d) => d.n), on: '06:00', off: '07:00' })
    expect(allDays.success).toBe(true)
  })
})

describe('BASE_WINDOW', () => {
  it('is a valid window on its own — weekdays, 09:00-17:00', () => {
    expect(BASE_WINDOW).toEqual({ days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00' })
    expect(WindowBase.safeParse(BASE_WINDOW).success).toBe(true)
    expect(NOT_SAME_BOUNDARY.check(BASE_WINDOW)).toBe(true)
  })

  it('is frozen, so a careless spread-target can never redefine the default', () => {
    expect(Object.isFrozen(BASE_WINDOW)).toBe(true)
    expect(() => { 'use strict'; BASE_WINDOW.on = '05:00' }).toThrow()
    expect(BASE_WINDOW.on).toBe('09:00')
  })
})
