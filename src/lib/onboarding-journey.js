// PULSE-90 — first-90-days journey pace math (pure, no I/O).
//
// North-star metric: % of new members who attend 9+ classes in their first
// 6 weeks (~2/week). This lib computes where a member sits against that
// pace; the data layer (onboarding-journey-data.js) feeds it rows and the
// /pulse lane, contact profile panel, /api/me/journey and the nudge cron
// all render from it — so the formulas live in exactly one place.
//
// HARD CONSTRAINT (pulse-scope-no-booking): the member-facing push copy
// built here is purely motivational — no "book"/"booking" language, no
// booking deep-links. The test suite greps every variant for /book/i.
//
// Day semantics: a journey day is a Europe/Dublin calendar day
// (dublinDateKey), NOT a UTC day — a 23:30 UTC session during IST belongs
// to the NEXT Dublin day. Day 0 is the Dublin day of joined_at
// (contacts.joined_at, timestamptz).

import { dublinDateKey } from '@/lib/dublin-time'

export const DEFAULT_JOURNEY_WINDOW_DAYS = 42
export const DEFAULT_JOURNEY_TARGET_CLASSES = 9

// Sanity bounds for per-location overrides (a fat-fingered 0 or 9999 falls
// back to the default rather than nuking the lane / dividing by zero).
const MIN_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 365
const MIN_TARGET_CLASSES = 1
const MAX_TARGET_CLASSES = 100

const DAYS_IN_WEEK = 7
// Grace: days 0–6 are never judged (no "behind" verdicts in week one).
const GRACE_LAST_DAY = 6
// At-risk when this many Dublin days pass with no attendance …
const QUIET_DAYS_AT_RISK = 10
// … but only once the journey itself is at least this old.
const QUIET_RULE_MIN_DAY = 10
// At-risk when the attended count trails the expected floor by this much.
const COUNT_DEFICIT_AT_RISK = 2

/**
 * Per-location journey config, merged over defaults — same defensive style
 * as resolveClassReminderLeadTimes (class-reminders.js). Reads
 * locations.notification_config.categories.onboarding_pace
 * .{window_days, target_classes}; each field falls back independently when
 * missing / non-numeric / out of bounds.
 *
 * @param {object|null} location  locations row (needs .notification_config)
 * @returns {{ windowDays: number, targetClasses: number }}
 */
export function resolveJourneyConfig(location) {
  const raw = location?.notification_config?.categories?.onboarding_pace
  return {
    windowDays: cleanInt(raw?.window_days, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS, DEFAULT_JOURNEY_WINDOW_DAYS),
    targetClasses: cleanInt(raw?.target_classes, MIN_TARGET_CLASSES, MAX_TARGET_CLASSES, DEFAULT_JOURNEY_TARGET_CLASSES),
  }
}

function cleanInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

/**
 * Epoch-day ordinal for a 'YYYY-MM-DD' Dublin day key. Diffing two of these
 * gives an exact whole-day count with no DST drift (the 23h/25h Dublin
 * transition days never enter the arithmetic).
 */
function dayKeyToEpochDays(key) {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}

/** Whole Dublin-calendar-days from instant a to instant b (b − a). */
function dublinDaysBetween(aMs, bMs) {
  return dayKeyToEpochDays(dublinDateKey(bMs)) - dayKeyToEpochDays(dublinDateKey(aMs))
}

/**
 * Where a member sits on their first-N-days journey.
 *
 * Formulas (spec 2026-06-28-pulse-hub-first-90-days-design):
 *   expectedByNow = floor((dayIndex / windowDays) * target)   [capped at target]
 *   completed  attended ≥ target (sticky — beats expired)
 *   expired    dayIndex > windowDays
 *   on_track   dayIndex ≤ 6 (grace — week one is never judged)
 *   at_risk    attended ≤ expectedByNow − 2, OR no attendance in the last
 *              10 Dublin days once dayIndex ≥ 10 (never attended counts)
 *   behind     attended < expectedByNow
 *   on_track   otherwise
 *
 * @param {object} opts
 * @param {string|number|Date} opts.joinedAt  contacts.joined_at (timestamptz)
 * @param {Array<string|number|Date>} [opts.attendedAt]  attended class start
 *   instants (class_bookings.starts_at, already window-filtered by the data
 *   layer); unparseable entries are ignored
 * @param {string|number|Date} [opts.now]
 * @param {{windowDays?: number, targetClasses?: number}} [opts.config]
 *   from resolveJourneyConfig; defaults 42/9
 * @returns {null | {
 *   inWindow: boolean, dayIndex: number, weekIndex: number,
 *   windowDays: number, attended: number, target: number,
 *   expectedByNow: number, status: 'on_track'|'behind'|'at_risk'|'completed'|'expired',
 *   lastAttendedAt: string|number|Date|null, daysSinceLastAttended: number|null,
 * }}  null when joinedAt is missing/unparseable
 */
export function journeyStatus({ joinedAt, attendedAt, now, config } = {}) {
  const joinedMs = toMs(joinedAt)
  if (joinedMs == null) return null
  const nowMs = toMs(now) ?? Date.now()

  const windowDays = cleanInt(config?.windowDays, MIN_WINDOW_DAYS, MAX_WINDOW_DAYS, DEFAULT_JOURNEY_WINDOW_DAYS)
  const target = cleanInt(config?.targetClasses, MIN_TARGET_CLASSES, MAX_TARGET_CLASSES, DEFAULT_JOURNEY_TARGET_CLASSES)

  // Day 0 = the Dublin day of joined_at. A pre-dated (future) joined_at
  // clamps to day 0 — the member is treated as brand-new, not out-of-window.
  const dayIndex = Math.max(0, dublinDaysBetween(joinedMs, nowMs))
  const inWindow = dayIndex <= windowDays
  const totalWeeks = Math.ceil(windowDays / DAYS_IN_WEEK)
  const weekIndex = Math.min(Math.floor(dayIndex / DAYS_IN_WEEK) + 1, totalWeeks)

  // Most recent parseable attendance (entries arrive window-filtered).
  let attended = 0
  let lastAttendedAt = null
  let lastAttendedMs = null
  for (const at of attendedAt || []) {
    const ms = toMs(at)
    if (ms == null) continue
    attended += 1
    if (lastAttendedMs == null || ms > lastAttendedMs) {
      lastAttendedMs = ms
      lastAttendedAt = at
    }
  }
  const daysSinceLastAttended = lastAttendedMs == null ? null : dublinDaysBetween(lastAttendedMs, nowMs)

  const expectedByNow = Math.min(Math.floor((dayIndex / windowDays) * target), target)

  let status
  if (attended >= target) {
    status = 'completed' // sticky — a finisher stays a finisher past day 42
  } else if (!inWindow) {
    status = 'expired'
  } else if (dayIndex <= GRACE_LAST_DAY) {
    status = 'on_track'
  } else {
    const quiet = dayIndex >= QUIET_RULE_MIN_DAY &&
      (daysSinceLastAttended == null || daysSinceLastAttended >= QUIET_DAYS_AT_RISK)
    if (quiet || attended <= expectedByNow - COUNT_DEFICIT_AT_RISK) status = 'at_risk'
    else if (attended < expectedByNow) status = 'behind'
    else status = 'on_track'
  }

  return {
    inWindow, dayIndex, weekIndex, windowDays,
    attended, target, expectedByNow, status,
    lastAttendedAt, daysSinceLastAttended,
  }
}

function toMs(value) {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// ---------------------------------------------------------------------------
// Member push copy — warm and motivational ONLY. Never any booking language
// (no "book"/"booking", no deep-links): Pulse never books, pauses or
// cancels, and the /book/i test in onboarding-journey.test.js enforces it.

/**
 * Push payload for the onboarding-pace nudge cron. data.type maps to the
 * existing 'progress' channel via shared/customer-push-channels.js, so
 * contacts.push_prefs applies with no new pref key.
 *
 * @param {{status?: string, attended?: number, target?: number}} [row]
 *   a journeyStatus() row (extra keys ignored)
 * @returns {{ title: string, body: string, data: { type: 'onboarding_pace' } }}
 */
export function buildOnboardingPacePush(row) {
  const attended = Number.isFinite(Number(row?.attended)) ? Number(row.attended) : 0
  const target = Number.isFinite(Number(row?.target)) && Number(row.target) > 0
    ? Number(row.target)
    : DEFAULT_JOURNEY_TARGET_CLASSES

  const variants = {
    completed: {
      title: `You smashed your first ${target} classes! 🎉`,
      body: 'That consistency is how results happen — keep it rolling.',
    },
    on_track: {
      title: 'Right on pace 💪',
      body: `${attended} of ${target} classes down and you're bang on track. Keep showing up!`,
    },
    behind: {
      title: 'Keep your momentum going',
      body: `You're at ${attended} of ${target} classes — a couple of sessions this week puts you right back on pace. 💪`,
    },
    at_risk: {
      title: "We've missed you this week",
      body: "One session is all it takes to get back in the groove — your coaches are ready when you are. You've got this!",
    },
  }
  const copy = variants[row?.status] || variants.behind

  return { title: copy.title, body: copy.body, data: { type: 'onboarding_pace' } }
}
