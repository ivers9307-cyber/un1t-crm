// src/lib/host-schedule-time.js
// HOST-SCHEDULE.1 — wall-clock helpers for scheduled host sends.
//
// Shared by the composer (browser) and the schedule route (server), so this
// file is Intl-only: no supabase, no server imports. `scheduled_for` is
// stored in UTC; the host sees and picks times on its OWN studio clock.
//
// TZ.9 — that clock is the host's anchor location's zone (`locations.timezone`
// of event_hosts.anchor_location_id; the composer page resolves it and hands
// it down). The private Dublin parts reader is gone: the maths is
// shared/zoned-time's (instantToZonedParts / zonedWallClockToInstant), and
// every function takes the zone, defaulting to DEFAULT_TZ (Europe/Dublin), so
// a Dublin host's inputs, labels and stored instants are byte-identical
// (events-races.tz.test.js, every quarter hour of 2026). The schedule route
// only compares instants (validateScheduledFor) and needs no zone.
import { DEFAULT_TZ, instantToZonedParts, zonedWallClockToInstant } from '@shared/zoned-time'

const MINUTE_MS = 60_000
export const QUARTER_MS = 15 * MINUTE_MS
/** How long the schedule panel's default stays valid after it is computed (see nextQuarterHour). */
export const CLICK_SLACK_MS = 2 * MINUTE_MS

/** A scheduled time must be at least this far ahead (the sweeper runs every 2 min). */
const MIN_LEAD_MIN = 15
export const MIN_LEAD_MS = MIN_LEAD_MIN * MINUTE_MS
/** ...and at most this far ahead. */
const MAX_LEAD_DAYS = 90
const DAY_MS = 24 * 60 * MINUTE_MS
export const MAX_LEAD_MS = MAX_LEAD_DAYS * DAY_MS

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] // ISO 1..7
const pad = (n) => String(n).padStart(2, '0')

function toMs(isoOrMs) {
  if (typeof isoOrMs === 'number') return Number.isFinite(isoOrMs) ? isoOrMs : null
  if (typeof isoOrMs === 'string' && isoOrMs !== '') {
    const ms = new Date(isoOrMs).getTime()
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * The composer's label for the zone it schedules in: the city part of the
 * IANA name ("Europe/Dublin" → "Dublin", "America/New_York" → "New York").
 * @param {string} [zone=DEFAULT_TZ]
 */
export function scheduleZoneLabel(zone = DEFAULT_TZ) {
  const z = String(zone || DEFAULT_TZ)
  return z.slice(z.lastIndexOf('/') + 1).replace(/_/g, ' ')
}

/**
 * UTC instant -> the { date: 'YYYY-MM-DD', time: 'HH:MM' } pair the
 * schedule panel's inputs hold, on the host's clock. Null for garbage.
 * @param {string|number} isoOrMs
 * @param {string} [zone=DEFAULT_TZ]
 */
export function isoToZonedInputs(isoOrMs, zone = DEFAULT_TZ) {
  const ms = toMs(isoOrMs)
  if (ms == null) return null
  const p = instantToZonedParts(ms, zone)
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` }
}

/**
 * Host wall clock ('YYYY-MM-DD', 'HH:MM') -> UTC ISO string, solved by
 * zonedWallClockToInstant and then VERIFIED: the instant must read back as
 * the wall clock that was asked for. A wall clock in the spring-forward gap
 * (e.g. 29 Mar 2026 01:30 Dublin, 8 Mar 2026 02:30 New York) does not exist
 * and returns null rather than an instant an hour off. An ambiguous
 * fall-back wall clock (25 Oct 2026 01:30 Dublin) resolves to one
 * deterministic instant (for Dublin the later, GMT, occurrence, as before).
 * Null when either input is malformed or the date does not exist.
 * @param {string} date
 * @param {string} time
 * @param {string} [zone=DEFAULT_TZ]
 */
export function zonedLocalToIso(date, time, zone = DEFAULT_TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '')
  const t = /^(\d{2}):(\d{2})$/.exec(time || '')
  if (!m || !t) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const h = Number(t[1]); const mi = Number(t[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const ms = zonedWallClockToInstant(date, time, zone) // null for a day that does not exist (Feb 30)
  if (ms == null) return null
  const check = instantToZonedParts(ms, zone)
  if (check.y !== y || check.mo !== mo || check.d !== d || check.h !== h || check.mi !== mi) return null
  return new Date(ms).toISOString()
}

/**
 * The panel's default: the first quarter hour that is still at least
 * MIN_LEAD_MS ahead AFTER the host has had CLICK_SLACK_MS to read the panel
 * and press Confirm, on the host's clock. Every IANA offset in use is a
 * multiple of 15 minutes, so UTC quarter boundaries are local quarter
 * boundaries.
 *
 * Why the slack: `validateScheduledFor` rejects anything under MIN_LEAD_MS
 * ahead of the moment the request arrives. A default computed as "first
 * quarter at or after now + MIN_LEAD_MS" can therefore be rejected by the
 * time the host clicks (worst case it was exactly MIN_LEAD_MS ahead when
 * the panel opened). Adding CLICK_SLACK_MS before rounding up floors the
 * margin at CLICK_SLACK_MS; lead time from `nowMs` lands in
 * [MIN_LEAD_MS + CLICK_SLACK_MS, MIN_LEAD_MS + CLICK_SLACK_MS + QUARTER_MS).
 * @param {number} [nowMs=Date.now()]
 * @param {string} [zone=DEFAULT_TZ]
 */
export function nextQuarterHour(nowMs = Date.now(), zone = DEFAULT_TZ) {
  const target = Math.ceil((nowMs + MIN_LEAD_MS + CLICK_SLACK_MS) / QUARTER_MS) * QUARTER_MS
  return isoToZonedInputs(target, zone)
}

/**
 * 'Wed 9 Sep, 09:00' on the host's clock. Built from parts (not a locale
 * pattern) so it reads the same on every ICU build. '' for null/garbage.
 * @param {string|number|null|undefined} isoOrMs
 * @param {string} [zone=DEFAULT_TZ]
 */
export function scheduleLabelIn(isoOrMs, zone = DEFAULT_TZ) {
  const ms = toMs(isoOrMs)
  if (ms == null) return ''
  const p = instantToZonedParts(ms, zone)
  return `${WEEKDAYS[p.weekday - 1]} ${p.d} ${MONTHS[p.mo - 1]}, ${pad(p.h)}:${pad(p.mi)}`
}


/**
 * The schedule route's window check. Returns { ok:true, iso } (normalised
 * to a UTC ISO string) or { ok:false, error } with host-facing copy.
 * @param {string|undefined} value  what the client posted
 * @param {number} [nowMs=Date.now()]
 */
export function validateScheduledFor(value, nowMs = Date.now()) {
  const ms = typeof value === 'string' && value ? toMs(value) : null
  if (ms == null) return { ok: false, error: 'Pick a date and time.' }
  if (ms < nowMs + MIN_LEAD_MS) return { ok: false, error: `Pick a time at least ${MIN_LEAD_MIN} minutes from now.` }
  if (ms > nowMs + MAX_LEAD_MS) return { ok: false, error: `Pick a time within the next ${MAX_LEAD_DAYS} days.` }
  return { ok: true, iso: new Date(ms).toISOString() }
}

/** Every quarter hour of the day for the time select. */
export const TIME_OPTIONS = Object.freeze(
  Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`),
)

/**
 * Plain-language copy for host_campaigns.schedule_error — what the sweeper
 * writes when a fire-time gate refuses. Operator tone, no em-dashes.
 *
 * Sibling vocabulary: `LAUNCH_GATE_REASONS` in src/lib/host-campaign-launch.js
 * (currently 'sender_not_verified' | 'no_stream' | 'daily_cap' |
 * 'no_recipients') is where the sweeper's gate codes actually come from —
 * keep the two in step. This file can't import that one directly: it pulls
 * in server-only code, and this file has to stay Intl-only/browser-safe.
 */
export const SCHEDULE_ERROR_COPY = Object.freeze({
  sender_not_verified: 'Sending is not enabled yet',
  no_stream: 'Marketing sending is not set up yet',
  daily_cap: 'Daily send limit was reached',
  no_recipients: 'Nobody on the list could be emailed',
  launch_failed: 'Could not start the send',
})

/** @param {string|null|undefined} code */
export function scheduleErrorCopy(code) {
  // Object.hasOwn, not `code in obj` / a truthy lookup: SCHEDULE_ERROR_COPY[code]
  // for code='constructor' resolves through the prototype chain to
  // Object.prototype.constructor (a function), not undefined — so a plain
  // `SCHEDULE_ERROR_COPY[code] || fallback` would return that function
  // instead of falling back. hasOwn only ever sees the frozen object's own
  // five keys.
  return typeof code === 'string' && Object.hasOwn(SCHEDULE_ERROR_COPY, code)
    ? SCHEDULE_ERROR_COPY[code]
    : SCHEDULE_ERROR_COPY.launch_failed
}
