// SHELLYGROUPS.5 — what a group is doing right now, for the group list.
//
// Pure: no I/O, no clock (nowMs is passed in, once per request). The caller
// resolves `windows` with the SAME engine call the cron uses
// (resolveServeWindows on the group row for the location's day), so the card
// and the relays can never disagree about whether a window is open.
//
//   on_count / member_count — members whose LAST READING says output true.
//     A member with no reading (null last_state, an output that is not
//     exactly `true`) is not on: absent is not on (status.js rule 1), and the
//     amber "1 of 2 on" must never be painted from a guess.
//   mode — the order planDeviceAction applies, for the GROUP's own fields:
//     'override' a live group override (isLiveOverride, the cron's predicate),
//                until = its `until`;
//     'none'     disabled or schedule_mode 'none' (planner rule 2);
//     'window'   inside a resolved window (on_at inclusive, off_at exclusive),
//                until = that window's off_at;
//     'idle'     outside every window, next_on = the next on_at later TODAY
//                (null when nothing is left today: tomorrow is not resolved).
//   A member's own device override is NOT reflected in `mode`: it is a
//   per-device fact, carried by the device rows themselves.
//
// `windows === null` means the caller could not resolve them (the timetable
// read failed for a class-mode group). That answers 'idle' with no times and
// `windows_unread: true` — saying "nothing is on" with a confident next_on
// would be inventing a schedule we did not read.

import { isLiveOverride } from './plan'

const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

export function describeGroupNow(group, members, windows, nowMs) {
  const list = Array.isArray(members) ? members : []
  const base = {
    on_count: list.filter((m) => m?.last_state?.output === true).length,
    member_count: list.length,
  }

  if (isLiveOverride(group?.override, nowMs)) {
    return { ...base, mode: 'override', until: group.override.until, next_on: null }
  }
  if (!group?.enabled || group.schedule_mode === 'none') {
    return { ...base, mode: 'none', until: null, next_on: null }
  }
  if (windows === null) {
    return { ...base, mode: 'idle', until: null, next_on: null, windows_unread: true }
  }

  const wins = Array.isArray(windows) ? windows : []
  const active = wins.find((w) => nowMs >= w.on_at && nowMs < w.off_at)
  if (active) return { ...base, mode: 'window', until: isoOf(active.off_at), next_on: null }

  const next = wins
    .filter((w) => Number.isFinite(w?.on_at) && w.on_at > nowMs)
    .reduce((min, w) => (min == null || w.on_at < min ? w.on_at : min), null)
  return { ...base, mode: 'idle', until: null, next_on: isoOf(next) }
}
