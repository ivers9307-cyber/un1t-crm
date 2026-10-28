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
//     SINCE SHELLYTIMERS.2 a relay we switched on carries a device-side timer
//     (see below), and disabling does not cancel it: the relay still switches
//     itself off at last_applied.cap_at. That is the safety net doing its job,
//     but it means "stays as it is" holds only until that cap.

// SHELLYTIMERS.2 — THE SAFETY NET. Only when the studio has switched it on
// (`options.timers === true`, from locations.settings.shelly.safety_timers;
// off by default so it can be proven live first), every `on` this planner
// emits for a MANAGED target (enabled, and a schedule that is not 'none') carries a
// device-side timer: `toggleAfterSec`, and `capAt`, the instant the device
// will switch itself off if nothing else has. It is the planned off time +
// SAFETY_MARGIN_MS — the window's off_at, or a live `on` override's until —
// so the cron's own close always comes first and the timer only ever fires
// when the cron did not (CRM down, Shelly cloud down, a stamp lost).
//   • NEVER on an `off` (the device would flip itself back ON), and NEVER for
//     an unmanaged target: "stays as you set it until you change it" is a
//     promise, and a timer would break it (Richard's ruling, 2026-10-26).
//   • The caller stamps `cap_at: capAt` on last_applied with the command, and
//     only for a command that landed (reconcile.js rule 3). `capAt` is
//     rounded UP to the minute (safetyCap) so devices in one window share one
//     timer and the reconcile can batch them in one set/groups call.
//   • RE-ARM (reason 'cap_extend'): inside a window, or under a live `on`
//     override, whose key is already stamped `on`, the planner re-sends `on`
//     with a later cap when the wanted cap is more than CAP_REARM_SLACK_MS past
//     the armed one — a class added to today, a gap merged. A SHRINKING window
//     is never re-sent: the cron's own close handles it, and the old, later
//     timer is harmless.
//   • An absent or unreadable `cap_at` (a row stamped before timers existed)
//     reads as "not armed": re-armed ONCE, and the stamp then carries cap_at,
//     so the next tick is quiet. Never a re-send every tick.
//   • A re-arm sends `on`, so it must not undo a human: it needs
//     `options.relayOn === true` (the caller's fresh reading). A relay read as
//     off (a person switched it off mid-window — header rule 3 says they win)
//     or not read at all is left alone. ONE exception: once the armed cap has
//     PASSED inside a live window, the off was probably our own timer's, and
//     rule 2's "re-open after our own close" applies to a relay we could not
//     read — but never to one READ as off, because a human off always wins.

import { resolveServeWindows } from '@/lib/schedule/desired-state'
import { DEFAULT_TZ } from '@shared/zoned-time'

export const overrideKey = (ov) => 'ov:' + (ov?.set_at || `${ov?.until}:${ov?.state}`)
export const windowKey = (w) => 'w:' + w.on_at

// The device switches itself off this long after the planned off time.
export const SAFETY_MARGIN_MS = 30 * 60_000
// A wanted cap must beat the armed one by MORE than this before we spend a
// request re-arming it. Above the minute rounding, so rounding alone never
// triggers a re-arm.
export const CAP_REARM_SLACK_MS = 60_000
const MINUTE_MS = 60_000

/**
 * The timer for a cap at `capAtMs`, sent at `nowMs`: rounded UP to the minute
 * (never earlier than wanted; one shared value for every device whose cap
 * falls in that minute, so they batch). null when there is nothing to arm —
 * a cap that is not in the future, or an unusable instant.
 *
 * @returns {{toggleAfterSec: number, capAt: string} | null}
 */
export function safetyCap(capAtMs, nowMs) {
  if (!Number.isFinite(capAtMs) || !Number.isFinite(nowMs) || capAtMs <= nowMs) return null
  const rounded = Math.ceil(capAtMs / MINUTE_MS) * MINUTE_MS
  const toggleAfterSec = Math.max(1, Math.ceil((rounded - nowMs) / 1000))
  return { toggleAfterSec, capAt: new Date(nowMs + toggleAfterSec * 1000).toISOString() }
}

// Rule 2's predicate, the one place "managed" is spelled for the timer.
export const isManagedTarget = (t) => !!t?.enabled && t?.schedule_mode !== 'none'

// Does a stamped `on` need its cap re-armed? See the header.
function needsRearm(last, wantedCapMs, nowMs, relayOn) {
  const armed = typeof last?.cap_at === 'string' ? Date.parse(last.cap_at) : NaN
  if (Number.isFinite(armed)) {
    if (wantedCapMs <= armed + CAP_REARM_SLACK_MS) return false
    // Our own timer has fired, so an off is probably ours — but a relay READ
    // as off may equally be a person's, and a person's off always wins: only
    // an unread relay (null) is re-opened on the strength of the cap alone.
    if (nowMs >= armed) return relayOn !== false
  }
  return relayOn === true
}

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

// → null | { action:'on'|'off', reason, key, toggleAfterSec?, capAt? }
// (the last two only on an `on` for a managed target — see the header).
//
// `options` is read defensively rather than destructured in the signature: a
// default parameter only fires for `undefined`, so an explicit null — the
// shape a caller threading an optional through gets for free — would throw.
// `options.relayOn` (true | false | null): the relay's freshly READ output,
// used only to decide a re-arm (see needsRearm).
// `options.timers` (boolean): the studio's safety-timer switch. Only an
// explicit true arms anything.
export function planDeviceAction(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ, options = {}) {
  const force = !!options?.force
  const relayOn = options?.relayOn
  const last = device?.last_applied && typeof device.last_applied === 'object' ? device.last_applied : null
  const same = (key, action) => last?.key === key && last?.action === action
  const managed = isManagedTarget(device)
  // SHELLYTIMERS.5 — the per-studio switch (locations.settings.shelly.
  // safety_timers). Off — the default — means no cap and no re-arm at all:
  // every answer is exactly what it was before timers existed.
  const timers = options?.timers === true

  // An `on` for `key`, planned off at `offAtMs`: armed when managed, and
  // re-armed rather than skipped when already stamped (see the header).
  const openOn = (key, offAtMs, reason) => {
    const cap = managed && timers ? safetyCap(offAtMs + SAFETY_MARGIN_MS, nowMs) : null
    if (!force && same(key, 'on')) {
      if (!cap || !needsRearm(last, offAtMs + SAFETY_MARGIN_MS, nowMs, relayOn)) return null
      return { action: 'on', reason: 'cap_extend', key, ...cap }
    }
    return { action: 'on', reason: force ? 'run_now' : reason, key, ...(cap || {}) }
  }

  // 1. Live override — every adopted device. See isLiveOverride for why an
  // unrecognised state is not one.
  const ov = device?.override
  if (isLiveOverride(ov, nowMs)) {
    const key = overrideKey(ov)
    if (ov.state === 'on') return openOn(key, new Date(ov.until).getTime(), 'override')
    if (!force && same(key, 'off')) return null
    return { action: 'off', reason: force ? 'run_now' : 'override', key }
  }

  // 2. Unmanaged / schedule switched off: never touched.
  if (!device?.enabled || device.schedule_mode === 'none') return null

  const windows = resolveServeWindows(device, dateStr, occurrences, tz)
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  // 3. Inside a window: on, unless THIS window is already on-stamped (and its
  // safety cap still covers it).
  if (active) return openOn(windowKey(active), active.off_at, 'window_open')

  // 4. Outside every window: close only what we opened.
  if (force) return { action: 'off', reason: 'run_now', key: `run:${nowMs}` }
  if (last?.action === 'on' && typeof last.key === 'string') {
    return { action: 'off', reason: last.key.startsWith('ov:') ? 'override_expired' : 'window_close', key: last.key }
  }
  return null
}
