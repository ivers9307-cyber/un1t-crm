import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { findWindowOverlap, SchedulePayload } from './route'

// SONOS.12 — planAction resolves an overlapping pair of windows
// earliest-starting-wins (windows is sorted ascending by on_at, then
// .find() returns the first match), so an unrejected overlap leaves the
// later/nested window silently dead: no error, no log line, nothing an
// operator could use to work out why it never fires. These tests exercise
// findWindowOverlap directly — the pure predicate SchedulePayload refines
// the `windows` array on — plus a couple of tests on the schema itself to
// prove the wiring (superRefine -> addIssue -> safeParse) actually holds.
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

describe('SchedulePayload windows overlap wiring', () => {
  const favourite = { volume: 30, favorite_id: 'fav-1' }

  it('rejects a payload whose windows overlap, naming both by time', () => {
    const parsed = SchedulePayload.safeParse({
      windows: [
        { days: [1], on: '06:00', off: '21:30', ...favourite },
        { days: [1], on: '10:00', off: '12:00', ...favourite },
      ],
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error.issues[0].message).toBe(
      'Windows overlap on the same day: 06:00-21:30 and 10:00-12:00',
    )
  })

  it('accepts a payload whose windows do not overlap', () => {
    const parsed = SchedulePayload.safeParse({
      windows: [
        { days: [1], on: '06:00', off: '09:00', ...favourite },
        { days: [1], on: '10:00', off: '12:00', ...favourite },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  // schedules/[id]/route.js builds its PATCH body as
  // `SchedulePayload.extend({ override: ... })`. .extend() preserves each
  // existing field's own schema (including an attached superRefine)
  // untouched, but that's worth pinning directly rather than trusting —
  // this is the exact cross-file coupling that would silently reopen the
  // overlap hole if `windows` were ever redefined in the extend() call
  // instead of just added to.
  it('keeps rejecting overlapping windows after .extend(), mirroring the [id] Patch schema', () => {
    const Extended = SchedulePayload.extend({
      override: z.object({ state: z.literal('off'), until: z.string().datetime() }).nullable().optional(),
    })
    const parsed = Extended.safeParse({
      windows: [
        { days: [1], on: '06:00', off: '21:30', ...favourite },
        { days: [1], on: '10:00', off: '12:00', ...favourite },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})
