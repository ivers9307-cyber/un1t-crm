// TZ.9 — FROZEN copies of the events / races / hyrox / host functions as they
// were before the sweep made them take the event's (or host's, or block's)
// studio zone. Test-only: the byte-identity tests in events-races.tz.test.js
// diff the new code (zone = 'Europe/Dublin') against these. Do not edit;
// TZ.18b deletes this file.
import { dublinTodayStr, dublinDateKey } from '@/lib/dublin-time'
import { eventKindLabel } from '@shared/events'
import { formatEventDate, formatEventTime, eventPriceLabel } from '@/lib/public-events'

// The "today" every event decision took before TZ.9 (registration-move's
// evaluateMove/listMoveTargets/checkMove/moveRegistration defaults, the three
// public entry routes, the waitlist route and runWaitlistOffers, the host move
// fence, the event-reminders cron).
export const dublinTodayLegacyDublin = () => dublinTodayStr()

// ── shared/events.js ───────────────────────────────────────────────────────
export function todayIsoDublinLegacyDublin() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

// ── src/lib/dates.js formatWeekdayLongDateInTZ at its Dublin default, as the
// race-confirmations / event-waitlist / event-attendee-reminders date labels
// called it ─────────────────────────────────────────────────────────────────
function formatWeekdayLongDateInDublin(value) {
  if (!value) return ''
  let d = value
  if (typeof value === 'string' && !value.includes('T')) {
    d = new Date(`${value}T00:00:00Z`)
  } else if (!(value instanceof Date)) {
    d = new Date(value)
  }
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d)
}

// race-confirmations fmtRaceDate / event-waitlist fmtDate
export function eventDateLongLegacyDublin(dateStr) {
  if (!dateStr) return ''
  return formatWeekdayLongDateInDublin(dateStr) || dateStr
}

// event-attendee-reminders reminderTimeLabel
export function reminderTimeLabelLegacyDublin(reg, ev) {
  const t = reg?.wave?.start_time || ev?.start_time || null
  const hhmm = typeof t === 'string' ? t.slice(0, 5) : ''
  const dateLabel = formatWeekdayLongDateInDublin(ev?.race_date) || ev?.race_date || ''
  if (dateLabel && hhmm) return `${dateLabel} · ${hhmm}`
  return dateLabel || hhmm || ''
}

// ── src/lib/public-events.js ───────────────────────────────────────────────
function formatOpensDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' }).format(d)
}

export function toBrowseCardLegacyDublin(e, { soldOut = false, now = Date.now() } = {}) {
  const opensAt = e?.registration_opens_at ? Date.parse(e.registration_opens_at) : null
  const closesAt = e?.registration_closes_at ? Date.parse(e.registration_closes_at) : null
  const closed = !!(closesAt && now > closesAt)
  let badge = null
  if (opensAt && now < opensAt) badge = `Opens ${formatOpensDate(e.registration_opens_at)}`
  else if (closed) badge = 'Registration closed'
  else if (soldOut) badge = 'Sold out'
  return {
    slug: e.slug,
    title: e.name,
    kindLabel: eventKindLabel(e.kind),
    dateLabel: formatEventDate(e.race_date),
    timeLabel: formatEventTime(e),
    venue: typeof e?.venue_name === 'string' && e.venue_name.trim() ? e.venue_name.trim() : null,
    priceLabel: eventPriceLabel(e),
    badge,
    closed,
  }
}

// ── src/lib/host-schedule-time.js ──────────────────────────────────────────
const DUBLIN_TZ = 'Europe/Dublin'
const MINUTE_MS = 60_000
const QUARTER_MS = 15 * MINUTE_MS
const CLICK_SLACK_MS = 2 * MINUTE_MS
const MIN_LEAD_MS = 15 * MINUTE_MS
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')
const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hour12: false,
})
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: DUBLIN_TZ, weekday: 'short' })
function dublinParts(ms) {
  const p = {}
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value
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
export function isoToDublinInputsLegacyDublin(isoOrMs) {
  const ms = toMs(isoOrMs)
  if (ms == null) return null
  const p = dublinParts(ms)
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` }
}
export function dublinLocalToIsoLegacyDublin(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '')
  const t = /^(\d{2}):(\d{2})$/.exec(time || '')
  if (!m || !t) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const h = Number(t[1]); const mi = Number(t[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  const g = new Date(guess)
  if (g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d) return null
  const p = dublinParts(guess)
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0)
  const corrected = guess - (wall - guess)
  const check = dublinParts(corrected)
  if (check.y !== y || check.mo !== mo || check.d !== d || check.h !== h || check.mi !== mi) return null
  return new Date(corrected).toISOString()
}
export function nextQuarterHourLegacyDublin(nowMs = Date.now()) {
  const target = Math.ceil((nowMs + MIN_LEAD_MS + CLICK_SLACK_MS) / QUARTER_MS) * QUARTER_MS
  return isoToDublinInputsLegacyDublin(target)
}
export function dublinScheduleLabelLegacyDublin(isoOrMs) {
  const ms = toMs(isoOrMs)
  if (ms == null) return ''
  const p = dublinParts(ms)
  return `${weekdayFmt.format(new Date(ms))} ${p.d} ${MONTHS[p.mo - 1]}, ${pad(p.h)}:${pad(p.mi)}`
}

// ── src/lib/hyrox/mapping.js ───────────────────────────────────────────────
export function dublinDateStrLegacyDublin(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return dublinDateKey(d)
}
function isoWeekdayOf(ymd) {
  const [y, m, day] = ymd.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay()
  return dow === 0 ? 7 : dow
}
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}
export function weekNoForLegacyDublin(startsOn, occurrenceIso, weeks) {
  const ymd = dublinDateStrLegacyDublin(occurrenceIso)
  if (!ymd) return null
  const diff = daysBetween(startsOn, ymd)
  if (!Number.isFinite(diff)) return null
  if (diff < 0) return null
  const wk = Math.floor(diff / 7) + 1
  if (weeks != null && wk > weeks) return null
  return wk
}
export function slotForLegacyDublin(sessionWeekdays, occurrenceIso) {
  const ymd = dublinDateStrLegacyDublin(occurrenceIso)
  const wd = ymd ? isoWeekdayOf(ymd) : null
  if (wd == null) return null
  const idx = sessionWeekdays.indexOf(wd)
  return idx === -1 ? null : idx + 1
}

// ── src/lib/hyrox/expand-runner.js "today" ─────────────────────────────────
export const hyroxExpandTodayLegacyDublin = (nowMs) => dublinDateKey(new Date(nowMs).toISOString())

// ── src/lib/hyrox/reminder-runner.js class time ────────────────────────────
export const hyroxClassTimeLabelLegacyDublin = (startsAt) => new Date(startsAt).toLocaleTimeString('en-IE', {
  timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
})
