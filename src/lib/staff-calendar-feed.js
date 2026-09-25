// src/lib/staff-calendar-feed.js
// ICSFEED.1 — a person's own published shifts as a subscribed calendar. Pure.
//
// WHAT GOES IN (00-INDEX default 5): the person's OWN assignments, PUBLISHED
// (block → rosters.status = 'published', the ROSTER-FIX.1 derivation) and LIVE
// (not cancelled, isLiveAssignment), at every studio, Dublin today −14 to +56.
//
// WHAT NEVER GOES IN: colleagues (only the person's own rows are ever read),
// assignment notes and partial_reason (manager working notes, COACHSCOPE.1 —
// not even selected), pay, rates, minimums, capacity.
//
// TIMES are written in UTC from each studio's own wall clock
// (locations.timezone via resolveTz; unknown → Europe/Dublin). Effective time
// = the coach's override, else the block's snapshot time (the mig 604/622
// COALESCE). A '24:00' end is the next day's midnight. An end at or before the
// start is dropped (RFC 5545: the event then ends at DTSTART).
//
// UID = shift-<assignment id>@repset.ie, stable for the assignment's life, so
// an edit replaces the event and a removed or cancelled shift disappears on the
// next poll. DTSTAMP/LAST-MODIFIED = the later updated_at of assignment and
// block, so the output is byte-identical until the roster changes. SEQUENCE
// is derived from the same instant (feedSequence), so an edit raises it and
// Outlook applies the change. Known gap: renaming a template or editing a
// studio's name/address changes SUMMARY/LOCATION without touching either
// updated_at, so SEQUENCE does not move for that alone.
//
// SCOPE is the PERSON, not an organisation: the feed carries the person's own
// assignments at every studio they are rostered at, across organisations if
// they work in more than one. Deliberate: it is their own diary, and nothing
// about anyone else is read.

import { addDaysISO } from '@/lib/dublin-time'
import { dayStartMsInTz, resolveTz, wallMsInTz } from '@/lib/tz-time'
import { isLiveAssignment } from '@/lib/roster'
import { buildIcsCalendar, MAX_ICS_INTEGER } from '@/lib/ics'

export const FEED_DAYS_BACK = 14
export const FEED_DAYS_AHEAD = 56
export const FEED_CALENDAR_NAME = 'Rostered shifts'
export const FEED_PRODID = '-//Repset//Staff shift feed//EN'
export const FEED_REFRESH_MINUTES = 60
export const FEED_EVENT_DESCRIPTION = 'Rostered shift, as published. Open the app for swaps and changes.'

/** The date window, from a Dublin YYYY-MM-DD today. */
export function feedWindow(todayIso) {
  return { from: addDaysISO(todayIso, -FEED_DAYS_BACK), to: addDaysISO(todayIso, FEED_DAYS_AHEAD) }
}

function hhmm(time) {
  const m = String(time ?? '').match(/^(\d{2}):(\d{2})(?::\d{2})?$/)
  return m ? `${m[1]}:${m[2]}` : null
}

/** UTC ms of wall-clock `time` (HH:MM[:SS]) on `dateIso` in `tz`; '24:00' = next day 00:00; null if unreadable. */
export function wallInstant(dateIso, time, tz) {
  const t = hhmm(time)
  if (!t) return null
  if (t === '24:00') {
    // addDaysISO rolls an impossible date over ('2026-02-30' + 1 is 3 March),
    // so prove the date exists before stepping past it. dayStartMsInTz is the
    // repo's "first instant of that local day" (it resolves a zone whose DST
    // starts at 00:00 to the transition, not to 23:00 the day before).
    if (dayStartMsInTz(dateIso, tz) == null) return null
    return dayStartMsInTz(addDaysISO(dateIso, 1), tz)
  }
  return wallMsInTz(dateIso, t, tz)
}

// SEQUENCE counts in whole seconds from this fixed instant, so it starts small
// and stays a valid 32-bit iCalendar INTEGER until the 2090s.
const SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1)

/**
 * RFC 5545 SEQUENCE for a shift last revised at `modifiedMs`: seconds since
 * 2026-01-01, clamped to [0, 2^31-1]. Both updated_at columns are maintained
 * by BEFORE UPDATE triggers (mig 067), so any edit to the assignment or its
 * block raises it, and an unchanged shift keeps it. 0 when there is no stamp.
 */
export function feedSequence(modifiedMs) {
  if (modifiedMs == null || !Number.isFinite(modifiedMs)) return 0
  const s = Math.floor((modifiedMs - SEQUENCE_EPOCH_MS) / 1000)
  return Math.min(Math.max(s, 0), MAX_ICS_INTEGER)
}

function msOrNull(iso) {
  const n = Date.parse(iso ?? '')
  return Number.isFinite(n) ? n : null
}

/** Published (block's roster is published) and live (not cancelled). */
export function isPublishedLiveRow(a) {
  return !!a && isLiveAssignment(a) && a.shift_blocks?.rosters?.status === 'published'
}

/** One assignment row (FEED_SHIFT_SELECT shape) → an event for buildIcsCalendar, or null. */
export function shiftToFeedEvent(a, location, generatedAtMs) {
  const b = a.shift_blocks
  const tz = resolveTz(location?.timezone)
  const startMs = wallInstant(b.block_date, a.start_time_override || b.start_time, tz)
  if (startMs == null) return null
  const endMs = wallInstant(b.block_date, a.end_time_override || b.end_time, tz)

  const stamps = [msOrNull(a.updated_at), msOrNull(b.updated_at)].filter((n) => n != null)
  const modified = stamps.length ? Math.max(...stamps) : null

  const studio = location?.name || null
  const shiftName = b.shift_templates?.name || 'Shift'
  return {
    uid: `shift-${a.id}@repset.ie`,
    dtstampMs: modified ?? generatedAtMs,
    lastModifiedMs: modified,
    startMs,
    endMs: endMs != null && endMs > startMs ? endMs : null,
    summary: studio ? `${shiftName} · ${studio}` : shiftName,
    location: [studio, location?.address].filter(Boolean).join(', ') || null,
    description: FEED_EVENT_DESCRIPTION,
    sequence: feedSequence(modified),
  }
}

/**
 * @param {object} args
 * @param {Array<object>} args.rows          FEED_SHIFT_SELECT rows (the person's own)
 * @param {Record<string, object>} args.locationsById  id → { name, address, timezone }
 * @param {number} args.generatedAtMs         DTSTAMP fallback only
 * @returns {string} the iCalendar body
 */
export function buildStaffShiftFeed({ rows, locationsById, generatedAtMs }) {
  const events = (rows || [])
    .filter(isPublishedLiveRow)
    .map((a) => shiftToFeedEvent(a, locationsById?.[a.shift_blocks.location_id], generatedAtMs))
    .filter(Boolean)
    .sort((x, y) => x.startMs - y.startMs || (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0))
  return buildIcsCalendar({
    prodId: FEED_PRODID,
    name: FEED_CALENDAR_NAME,
    refreshMinutes: FEED_REFRESH_MINUTES,
    events,
  })
}
