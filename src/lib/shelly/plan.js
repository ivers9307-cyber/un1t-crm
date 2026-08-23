// SHELLY.5 — boundary exactly-once planner for relays (the Sonos planAction
// model) plus a two-way manual override. Pure: no I/O, no clock.
//
// last_applied = { key, action, reason, at }. Keys are STRINGS by design —
// 'w:<on_at ms>' for a window, 'ov:<set_at>' for an override, 'run:<ms>' for
// run-now — so the Sonos toMs class of bug (a jsonb number that comes back as
// a string and never === matches) cannot happen here.
//
// Three things differ from Sonos, all because a relay's `on` is idempotent:
//  1. A live override is applied for EVERY adopted device, enabled or not —
//     a manual action is independent of the schedule, and applying it here
//     is what lets a failed direct toggle self-heal next tick.
//  2. Inside a window we re-open after our own close under the same key —
//     a class window that shrank for one tick (occurrence-sync blip) must not
//     leave the room dark all day.
//  3. Outside every window we close whenever the last thing WE did was an
//     `on`, window or override. A human's physical `on` is never stamped, so
//     it is never undone here. Humans win between boundaries.
//
// WHAT IS TOLERATED, AND WHAT IS NOT. `device` is a jsonb-bearing row and is
// read defensively throughout: no shape of `override`, `last_applied`,
// `fixed_windows`, `class_rule`, `enabled` or `schedule_mode` makes this
// throw (62 shapes probed, both host zones). The other three arguments are
// CALLER CONTRACTS, and deliberately not defended:
//   • `tz` — a non-empty invalid zone throws, per the engine's documented
//     contract. The edge must pass it through resolveTz() and log the
//     rejection; see the header of src/lib/schedule/desired-state.js.
//   • `dateStr` — must be a real 'YYYY-MM-DD' for the LOCATION's day, i.e.
//     dayStrInTz(now, tz). Junk throws inside the engine's yesterday-tail
//     maths. Swallowing it would be worse than the throw: with no windows
//     resolved, every device would read as "outside every window" and the
//     location would switch itself off.
//   • `nowMs` — must be a finite epoch ms (Date.now()). A NaN clock does NOT
//     answer null: every comparison against it is false, so no override is
//     live and no window is active, and every device we have stamped `on`
//     gets a location-wide `off`. Compute it ONCE per tick and guard it with
//     Number.isFinite before the sweep — not per device, or a location can
//     straddle a boundary mid-loop.
// All three are computed once per tick by the caller, never read from a row.
//
// FOUR EDGES, each with an obligation on the code around this file:
//  a. `override.set_at` is LOAD-BEARING. It IS the key, and the fallback when
//     it is missing is `until:state` — so two overrides with the same until
//     and state mint the SAME key, and the second one is read as already
//     applied and never fires. PR 2's zod must make `set_at` a required ISO
//     datetime and `state` a strict enum of 'on'|'off'; this planner cannot
//     tell a re-issued override from a repeat of the old one without it.
//  b. OVERLAPPING windows: `.find()` over an on_at-sorted list means the
//     EARLIEST-starting window wins, the same deliberate tie-break
//     src/lib/sonos/groups.js documents. Nothing in validation forbids the
//     overlap. Consequence: when the earlier window ends while the later is
//     still open, the key changes and a redundant `on` is re-issued. Harmless
//     for a relay (idempotent) and visible in the action log; it is exactly
//     the re-issue that Sonos could not afford.
//  c. TOUCHING windows (07:00-12:00, 12:00-21:30) do NOT produce a close at
//     the seam: `on_at` is inclusive and `off_at` exclusive, so 12:00 belongs
//     to the later window only. One `on`, no flicker.
//  d. DISABLING a device mid-window leaves the relay exactly as it is — rule 2
//     returns before rule 4 can close it, by design, since `enabled:false`
//     means "this is not mine to touch" rather than "switch it off". PR 2's
//     disable action must therefore either send an explicit off itself or say
//     so in the UI; a plug silently left on all night is a support ticket.

import { resolveServeWindows } from '@/lib/schedule/desired-state'
import { DEFAULT_TZ } from '@/lib/tz-time'

export const overrideKey = (ov) => 'ov:' + (ov?.set_at || `${ov?.until}:${ov?.state}`)
export const windowKey = (w) => 'w:' + w.on_at

// Rule 1's predicate, exported so it cannot drift from its callers: Task 8's
// reconcile needs it to decide whether a class-mode device may be SKIPPED on an
// occurrence load error (a live override must still be applied, because a
// manual action does not depend on the timetable), and PR 2's toggle route
// needs it to answer "is one in force?". Three copies of "is this live" is how
// the cron and the UI end up disagreeing about a relay.
//
// The state must be EXACTLY 'on' or 'off'. The engine's desiredState reads this
// field as `x === 'on' ? 'on' : 'off'`, which is safe for the question IT
// answers, but here it would mean that 'ON', a stray trailing space, or a jsonb
// boolean `true` — which plainly means ON — all send a physical OFF. An
// unrecognised state is not a live override at all: the device follows its
// schedule, which is defined behaviour, instead of being switched on a value we
// failed to understand. Same for an `until` we cannot date (an unparseable
// string, a number-as-string, an object): NaN > nowMs is false, so it is simply
// not live — and a NaN `nowMs` makes every override read as expired, which is
// the second reason callers must guard the clock (see the header).
export function isLiveOverride(ov, nowMs) {
  if (ov?.state !== 'on' && ov?.state !== 'off') return false
  if (!ov.until) return false
  return new Date(ov.until).getTime() > nowMs
}

// → null | { action:'on'|'off', reason, key }
//
// `options` is read defensively rather than destructured in the signature: a
// default parameter only fires for `undefined`, so an explicit null — the
// shape a caller threading an optional through gets for free — would throw.
export function planDeviceAction(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ, options = {}) {
  const force = !!options?.force
  const last = device?.last_applied && typeof device.last_applied === 'object' ? device.last_applied : null
  const same = (key, action) => last?.key === key && last?.action === action

  // 1. Live override — every adopted device. See isLiveOverride for why an
  // unrecognised state is not one.
  const ov = device?.override
  if (isLiveOverride(ov, nowMs)) {
    const action = ov.state
    const key = overrideKey(ov)
    if (!force && same(key, action)) return null
    return { action, reason: force ? 'run_now' : 'override', key }
  }

  // 2. Unmanaged / schedule switched off: never touched.
  if (!device?.enabled || device.schedule_mode === 'none') return null

  const windows = resolveServeWindows(device, dateStr, occurrences, tz)
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  // 3. Inside a window: on, unless THIS window is already on-stamped.
  if (active) {
    const key = windowKey(active)
    if (!force && same(key, 'on')) return null
    return { action: 'on', reason: force ? 'run_now' : 'window_open', key }
  }

  // 4. Outside every window: close only what we opened.
  if (force) return { action: 'off', reason: 'run_now', key: `run:${nowMs}` }
  if (last?.action === 'on' && typeof last.key === 'string') {
    return { action: 'off', reason: last.key.startsWith('ov:') ? 'override_expired' : 'window_close', key: last.key }
  }
  return null
}
