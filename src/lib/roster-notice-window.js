// PUBSUMMARY.1 (Richard's decision, 3 Nov 2026) — when a change to a
// PUBLISHED shift is told.
//
// A change to a shift that starts within NOTICE_NOW_WINDOW_MS (24 hours), or
// has already started, is told at the moment of change, as it always was:
// a phone edit (cover for a sick coach) has no Publish button behind it.
// Every other change is HELD: its roster_change_log row stays unstamped and
// the manager's next Publish tells each coach about all of theirs in one
// summary (renotifyChangedCoaches, src/lib/roster-notify.js). Before this a
// coach without the app got one email per edit.
//
// Pure and client-safe: the save toasts (block-edit.js, shift-replace.js)
// say the same thing the senders do.

import { zonedWallClockToInstant, resolveZone } from '@shared/zoned-time'

export const NOTICE_NOW_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Is a change to this shift told NOW (true) or held for the next Publish
 * (false)? Judged on the studio's clock. An unreadable date or start reads
 * as true: telling now is what every change did before, and holding a change
 * nobody may ever publish is the loss to avoid.
 *
 * @param {{ blockDate: string, startTime?: string|null }} shift
 * @param {{ nowMs?: number, zone?: string|null }} opts
 */
export function startsWithinNoticeWindow({ blockDate, startTime } = {}, { nowMs = Date.now(), zone = null } = {}) {
  const startMs = zonedWallClockToInstant(blockDate, String(startTime ?? '').slice(0, 8), resolveZone(zone))
  if (startMs == null || !Number.isFinite(nowMs)) return true
  return startMs - nowMs <= NOTICE_NOW_WINDOW_MS
}
