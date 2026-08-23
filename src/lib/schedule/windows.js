// SHELLY-UI.1 — the fixed-window vocabulary, lifted out of
// src/app/api/sonos/schedules/route.js so Sonos and Shelly validate a
// recurring on/off window with ONE implementation instead of two that
// drift. Nothing here changed on the way over: the helpers and their
// comments are the Sonos originals verbatim, and the Sonos route now
// re-exports findWindowOverlap from here.
//
// Those moved comments still say "below" and name route.test.js, because
// that is where they were written. Read them against this file as:
//   • "the Window .refine below"     → NOT_SAME_BOUNDARY, applied by each
//                                      caller AFTER its own .extend()
//   • "the SchedulePayload refinement below" → windowsOverlapIssue
//   • "unit-tested directly (route.test.js)" → windows.test.js, which is
//                                      where that describe block now lives
//
// WHY WindowBase CARRIES NO REFINE: a refined Zod object is a ZodEffects,
// and ZodEffects has no .extend(). Sonos extends the base with
// volume/favorite_id and Shelly does not extend it at all, so the same-
// boundary rule ships as a plain predicate + message pair that each caller
// applies with .refine() as its LAST step. Attaching it here would make
// the Sonos extend impossible; re-typing the predicate per caller is how
// the two would eventually disagree about what an empty window is.

import { z } from 'zod'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const MINUTES_PER_DAY = 24 * 60

function toMinutes(hhmm) {
  const s = String(hhmm || '')
  // HHMM has only one capture group (around the hour — its sole original
  // purpose was a boolean .regex() check), so pulling minutes out of a
  // capture-group index is fragile. Validate with .test(), then split.
  if (!HHMM.test(s)) return null
  const [hh, mm] = s.split(':')
  return Number(hh) * 60 + Number(mm)
}

// A same-day window (off after on) occupies one clock range. An overnight
// window (off before on — the Window .refine below already refuses
// on === off, so "not after" only ever means "before") is modelled as
// wrapping the clock face: the late segment up to midnight AND the early
// segment from midnight. That is deliberately what the window occupies on
// every day it recurs on — the tail of yesterday's run lands in exactly
// that early-morning slot (resolveServeWindows in
// src/lib/schedule/desired-state.js serves it) — so a single, non-recurring
// overnight window gets the same treatment as a recurring one. The cost is
// a rare false positive on a genuinely isolated overnight window with no
// neighbour; the alternative is a miss on the case this exists to catch.
function occupiedSegments(on, off) {
  const onMin = toMinutes(on)
  const offMin = toMinutes(off)
  if (onMin == null || offMin == null) return []
  if (offMin > onMin) return [[onMin, offMin]]
  return [[onMin, MINUTES_PER_DAY], [0, offMin]]
}

// Half-open — touching boundaries (one window's off equals the other's on)
// is fine, matching planAction's own `nowMs < off_at` check.
function segmentsOverlap(a, b) {
  return a[0] < b[1] && b[0] < a[1]
}

function sharesDay(daysA, daysB) {
  const a = Array.isArray(daysA) ? daysA : []
  const b = Array.isArray(daysB) ? daysB : []
  return a.some((d) => b.includes(d))
}

// Pure — no zod, no I/O — so it is unit-tested directly (route.test.js)
// and reused by the SchedulePayload refinement below.
//
// Why this exists: planAction resolves an overlap earliest-wins (windows
// is sorted ascending by on_at, then .find() returns the first match), so
// a later-starting or nested window in a clashing pair is silently NEVER
// applied — no error, no log line, no way for an operator to tell why a
// window does nothing. Refusing the save at write time is the only place
// this can surface.
//
// Returns the first clashing [windowA, windowB] pair found, or null.
export function findWindowOverlap(windows) {
  const list = Array.isArray(windows) ? windows : []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (!sharesDay(a?.days, b?.days)) continue
      const segsA = occupiedSegments(a?.on, a?.off)
      const segsB = occupiedSegments(b?.on, b?.off)
      if (segsA.some((sa) => segsB.some((sb) => segmentsOverlap(sa, sb)))) {
        return [a, b]
      }
    }
  }
  return null
}

// The three fields every fixed window has, whatever the device is. NO
// refine — see the header. Callers extend (Sonos: volume + favorite_id) or
// use as-is (Shelly), then apply NOT_SAME_BOUNDARY last.
export const WindowBase = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  on: z.string().regex(HHMM),
  off: z.string().regex(HHMM),
})

// Equal boundaries make the engine treat the window as overnight and
// resolve a 24-hour always-on span — the exact trap the Tapo build hit.
export const NOT_SAME_BOUNDARY = {
  check: (w) => w.on !== w.off,
  message: 'A window must not start and end at the same time',
}

// The superRefine body for an array of windows. Cross-item check: a single
// Window's own .refine only catches on === off. Two DIFFERENT windows that
// overlap on a shared day pass that check individually and are only wrong
// together — see findWindowOverlap above for why an undetected overlap is
// a silent, permanent dead window rather than a loud failure.
export function windowsOverlapIssue(windows, ctx) {
  const clash = findWindowOverlap(windows)
  if (!clash) return
  const [a, b] = clash
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Windows overlap on the same day: ${a.on}-${a.off} and ${b.on}-${b.off}`,
  })
}

export { HHMM }
