// src/lib/host-schedule-time.js
// HOST-SCHEDULE.1 — Dublin wall-clock helpers for scheduled host sends.
//
// Shared by the composer (browser) and the schedule route (server), so this
// file is Intl-only: no supabase, no server imports. `scheduled_for` is
// stored in UTC; the host only ever sees and picks Europe/Dublin times.
// Hard-codes the zone like src/lib/dublin-time.js does (UN1T is Dublin-only).
//
// Why not import src/lib/dublin-time.js instead of duplicating dublinParts()?
// NOT because that file is server-only — it's Intl-only too, so it would be
// just as safe here. The real reasons: its `dublinParts` is a private,
// unexported helper (nothing outside that file can call it), and its
// exported label helper (`dublinTimeLabel`) doesn't apply the '24'-hour
// normalisation this file's own `dublinParts` does (some ICU builds' en-GB
// formatter can emit hour '24' at midnight) — the schedule panel's date/time
// inputs need that normalisation. Don't "simplify" this file by importing
// dublin-time.js instead; it can't do this file's job as-is.

const DUBLIN_TZ = 'Europe/Dublin'
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
const pad = (n) => String(n).padStart(2, '0')

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hour12: false,
})
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: DUBLIN_TZ, weekday: 'short' })

/** Europe/Dublin wall-clock parts for a UTC ms instant. */
function dublinParts(ms) {
  const p = {}
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value
  // 'en-GB' can emit hour '24' at midnight; normalise to 0.
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: hour, mi: Number(p.minute) }
}

function toMs(isoOrMs) {
  if (typeof isoOrMs === 'number') return Number.isFinite(isoOrMs) ? isoOrMs : null
  if (typeof isoOrMs === 'string' && isoOrMs !== '') {
    const ms = new Date(isoOrMs).getTime()
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * UTC instant -> the { date: 'YYYY-MM-DD', time: 'HH:MM' } pair the
 * schedule panel's inputs hold, in Dublin time. Null for garbage.
 * @param {string|number} isoOrMs
 */
export function isoToDublinInputs(isoOrMs) {
  const ms = toMs(isoOrMs)
  if (ms == null) return null
  const p = dublinParts(ms)
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` }
}

/**
 * Dublin wall clock ('YYYY-MM-DD', 'HH:MM') -> UTC ISO string. Robust
 * across DST: take the naive UTC instant for the wall clock, read back what
 * Dublin wall clock that instant actually is, and correct by the observed
 * offset — then verify the correction actually landed on the wall clock
 * that was asked for. That verification matters because one correction
 * pass is NOT always exact: a wall clock that falls in the spring-forward
 * gap (e.g. 29 Mar 2026 01:30 Dublin — skipped when clocks jump straight
 * from 01:00 to 02:00) doesn't exist, and "correcting" for it resolves to
 * an instant an hour EARLY than intended (a caller asking for 01:30 would
 * silently get back an instant that reads back as 00:30 Dublin, not
 * 01:30). So after computing the corrected instant, this reads Dublin
 * wall-clock parts back off it and compares to the date/time requested;
 * a mismatch (only possible for a DST-gap time) returns null rather than
 * a wrong instant. An ambiguous fall-back wall clock (e.g. 25 Oct 2026
 * 01:30, which happens twice as clocks fall back from 02:00 to 01:00) is
 * NOT rejected this way — it resolves to the later (GMT) occurrence,
 * because the naive UTC guess for that wall clock always lands at or
 * after the transition instant. Null when either input is malformed or
 * the date does not exist.
 * @param {string} date
 * @param {string} time
 */
export function dublinLocalToIso(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '')
  const t = /^(\d{2}):(\d{2})$/.exec(time || '')
  if (!m || !t) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const h = Number(t[1]); const mi = Number(t[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  // Date.UTC silently rolls an impossible day (Feb 30) forward; reject that.
  const g = new Date(guess)
  if (g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d) return null
  const p = dublinParts(guess)
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0)
  const corrected = guess - (wall - guess)
  // Verify: a non-existent wall clock (the DST spring-forward gap) still
  // won't read back as what was asked for, even after the correction.
  const check = dublinParts(corrected)
  if (check.y !== y || check.mo !== mo || check.d !== d || check.h !== h || check.mi !== mi) return null
  return new Date(corrected).toISOString()
}

/**
 * The panel's default: the first quarter hour that is still at least
 * MIN_LEAD_MS ahead AFTER the host has had CLICK_SLACK_MS to read the panel
 * and press Confirm. Dublin's offset is a whole hour, so UTC quarter
 * boundaries are Dublin quarter boundaries.
 *
 * Why the slack: `validateScheduledFor` rejects anything under MIN_LEAD_MS
 * ahead of the moment the request arrives. A default computed as "first
 * quarter at or after now + MIN_LEAD_MS" can therefore be rejected by the
 * time the host clicks (worst case it was exactly MIN_LEAD_MS ahead when
 * the panel opened). Adding CLICK_SLACK_MS before rounding up floors the
 * margin at CLICK_SLACK_MS; lead time from `nowMs` lands in
 * [MIN_LEAD_MS + CLICK_SLACK_MS, MIN_LEAD_MS + CLICK_SLACK_MS + QUARTER_MS).
 * @param {number} [nowMs=Date.now()]
 */
export function nextQuarterHour(nowMs = Date.now()) {
  const target = Math.ceil((nowMs + MIN_LEAD_MS + CLICK_SLACK_MS) / QUARTER_MS) * QUARTER_MS
  return isoToDublinInputs(target)
}

/**
 * 'Wed 9 Sep, 09:00' in Dublin time. Built from parts (not a locale
 * pattern) so it reads the same on every ICU build. '' for null/garbage.
 * @param {string|number|null|undefined} isoOrMs
 */
export function dublinScheduleLabel(isoOrMs) {
  const ms = toMs(isoOrMs)
  if (ms == null) return ''
  const p = dublinParts(ms)
  return `${weekdayFmt.format(new Date(ms))} ${p.d} ${MONTHS[p.mo - 1]}, ${pad(p.h)}:${pad(p.mi)}`
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
