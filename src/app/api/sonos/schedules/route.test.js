import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { SchedulePayload } from './route'

// SONOS.12 — planAction resolves an overlapping pair of windows
// earliest-starting-wins (windows is sorted ascending by on_at, then
// .find() returns the first match), so an unrejected overlap leaves the
// later/nested window silently dead: no error, no log line, nothing an
// operator could use to work out why it never fires.
//
// SHELLY-UI.1 — the pure predicate (findWindowOverlap) and its unit tests
// moved to src/lib/schedule/windows.js + windows.test.js, where Shelly
// reads them too. What stays here is what is specific to THIS route: that
// the wiring (superRefine -> addIssue -> safeParse) actually holds on the
// composed SchedulePayload, and keeps holding through .extend(). That is
// the half that could silently unwire when the schema is rebuilt, so it is
// pinned against the schema this file exports, not against the helper.
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

// SONOSPLAYERVOL.1 — the per-speaker map is optional, keyed by player id,
// integer 0-100, and capped at the schedule's own speaker cap.
describe('SchedulePayload player_volumes', () => {
  const base = { days: [1], on: '06:00', off: '09:00', volume: 30, favorite_id: 'fav-1' }

  it('accepts a window with no player_volumes (the pre-existing shape)', () => {
    expect(SchedulePayload.safeParse({ windows: [base] }).success).toBe(true)
  })

  it('accepts a player id → integer level map', () => {
    const parsed = SchedulePayload.safeParse({
      player_ids: ['RINCON_1', 'RINCON_2'],
      windows: [{ ...base, player_volumes: { RINCON_1: 20, RINCON_2: 45 } }],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data.windows[0].player_volumes).toEqual({ RINCON_1: 20, RINCON_2: 45 })
  })

  it('rejects a level outside 0-100, a non-integer, and an empty key', () => {
    expect(SchedulePayload.safeParse({ windows: [{ ...base, player_volumes: { RINCON_1: 140 } }] }).success).toBe(false)
    expect(SchedulePayload.safeParse({ windows: [{ ...base, player_volumes: { RINCON_1: 20.5 } }] }).success).toBe(false)
    expect(SchedulePayload.safeParse({ windows: [{ ...base, player_volumes: { '': 20 } }] }).success).toBe(false)
    expect(SchedulePayload.safeParse({ windows: [{ ...base, player_volumes: [20] }] }).success).toBe(false)
  })

  it('rejects more than 32 speaker volumes on one window', () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`RINCON_${i}`, 30]))
    const parsed = SchedulePayload.safeParse({ windows: [{ ...base, player_volumes: many }] })
    expect(parsed.success).toBe(false)
    expect(parsed.error.issues[0].message).toBe('At most 32 speaker volumes per window')
  })
})
