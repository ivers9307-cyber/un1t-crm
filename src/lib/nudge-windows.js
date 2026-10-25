// src/lib/nudge-windows.js — TZ.17. The calendar windows the daily member-nudge
// crons pick candidates in. Pure.
//
// notify-streak-at-risk acts for a home studio at its daily slot (TZ.6,
// src/lib/cron-daily-slot.js, unchanged here) and looks for members who trained
// YESTERDAY. "Yesterday" is the studio's calendar day before the slot's day,
// bounded by its local midnights. Until TZ.17 a Europe/Dublin (legacy UTC-hour)
// slot used the UTC day instead: in Irish summer time that missed sessions
// from 00:00 to 01:00 yesterday and counted those from 00:00 to 01:00 today.
//
// The dedup key does NOT move: it is still the slot's day, which for a Dublin
// slot at its legacy 11:00 UTC is the same date in both calendars. So a member
// is nudged at most once per studio day across the deploy (the slot claim stops
// a second run that day, and the nudge ledger is keyed on that same day).
import { addDaysIn, dayStartMsIn } from '@/lib/location-time'

/**
 * @param {{ day: string, zone: string }} slot a due daily slot (gate.slots value)
 * @returns {{ yestMs: number, todayMs: number, dedupKey: string }}
 *   [yestMs, todayMs): yesterday in the slot studio's zone; dedupKey: the slot day.
 */
export function streakCandidateWindow(slot) {
  return {
    todayMs: dayStartMsIn(slot.day, slot.zone),
    yestMs: dayStartMsIn(addDaysIn(slot.day, -1, slot.zone), slot.zone),
    dedupKey: slot.day,
  }
}
