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
//   • `nowMs` — must be a finite epoch ms (Date.now()). A NaN clock resolves
//     no active window, so the same location-wide off applies.
// All three are computed once per tick by the caller, never read from a row.

import { resolveServeWindows } from '@/lib/schedule/desired-state'
import { DEFAULT_TZ } from '@/lib/tz-time'

export const overrideKey = (ov) => 'ov:' + (ov?.set_at || `${ov?.until}:${ov?.state}`)
export const windowKey = (w) => 'w:' + w.on_at

// → null | { action:'on'|'off', reason, key }
//
// `options` is read defensively rather than destructured in the signature: a
// default parameter only fires for `undefined`, so an explicit null — the
// shape a caller threading an optional through gets for free — would throw.
export function planDeviceAction(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ, options = {}) {
  const force = !!options?.force
  const last = device?.last_applied && typeof device.last_applied === 'object' ? device.last_applied : null
  const same = (key, action) => last?.key === key && last?.action === action

  // 1. Live override — every adopted device.
  //
  // The state must be EXACTLY 'on' or 'off'. The engine's desiredState reads
  // this field as `x === 'on' ? 'on' : 'off'`, which is safe for the question
  // IT answers, but here it would mean that 'ON', a stray trailing space, or a
  // jsonb boolean `true` — which plainly means ON — all send a physical OFF.
  // An unrecognised state is not a live override at all: the device follows
  // its schedule, which is defined behaviour, instead of being switched on a
  // value we failed to understand. Same for a `until` we cannot date (an
  // unparseable string, a number-as-string, an object): NaN > nowMs is false,
  // so it is simply not live.
  const ov = device?.override
  if ((ov?.state === 'on' || ov?.state === 'off') && ov.until && new Date(ov.until).getTime() > nowMs) {
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
