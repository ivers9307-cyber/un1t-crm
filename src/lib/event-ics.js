// W1.L5 — the customer's event .ics carries the TENANT's identity.
//
// Until this the file (built inline in RaceConfirmedPage) said
// `PRODID:-//UN1T//Events//EN`, `UID:<id>@un1tdublin.com` and fell back to
// `SUMMARY:UN1T Event`: a second gym's attendee would have imported the
// first gym's wordmark into their calendar. The PRODID is now the platform
// (the software that made the file, the way Google and Apple name
// themselves), the UID domain is the tenant's customer host
// (<org.slug>.repset.ie or their custom domain, resolveCustomerBaseUrl)
// and the summary fallback is the tenant's brand (getLocationBranding).
//
// buildEventIcs is pure so it is testable without React; the server page
// resolves the identity once and hands it to the client component as props.

import { PLATFORM_NAME } from './brand-name'
import { getLocationBranding } from './location-branding.js'
import { PLATFORM_HOST_SUFFIX, resolveCustomerBaseUrl } from './tenant-host.js'

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000
const DEFAULT_START_TIME = '09:00'

const pad = (n) => String(n).padStart(2, '0')

// Floating local time (no Z): the instant is composed from Dublin wall-clock
// parts with Date.UTC, so reading it back with the UTC getters yields those
// same parts whatever the host machine's offset.
function floating(ms) {
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`
}

function toMs(v) {
  if (v == null || v === '') return NaN
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return new Date(v).getTime()
}

/** RFC 5545 TEXT escaping: backslash, comma, semicolon, newline. */
export function escapeIcsText(s) {
  return String(s || '').replace(/([\\,;])/g, '\\$1').replace(/\r?\n/g, '\\n')
}

/**
 * Pure: a Dublin wall-clock `race_date` (+ `HH:MM[:SS]` start) as the
 * UTC-shaped instant buildEventIcs renders as floating local time. Never
 * parses `${date}T${time}` through the host's zone (CLAUDE.md, Timezones).
 * @returns {number|null} null when there is no date
 */
export function eventWallClockMs(raceDate, startTime) {
  if (!raceDate) return null
  const [y, mo, d] = String(raceDate).slice(0, 10).split('-').map(Number)
  if (!y) return null
  const [hh, mm] = String(startTime || DEFAULT_START_TIME).slice(0, 5).split(':').map(Number)
  return Date.UTC(y, (mo || 1) - 1, d || 1, hh || 0, mm || 0)
}

/**
 * Pure. Builds one VEVENT calendar file.
 * @param {object} event
 * @param {string} event.id          the UID's local part (the registration id)
 * @param {string} [event.title]     SUMMARY; empty → `${brandName} event`
 * @param {number|string|Date} event.startsAt  wall-clock instant (see eventWallClockMs)
 * @param {number|string|Date} [event.endsAt]  default start + 2h
 * @param {string} [event.location]  LOCATION, omitted when empty
 * @param {string} [event.description] DESCRIPTION, omitted when empty
 * @param {{ brandName?: string, hostname?: string }} identity
 * @returns {string} CRLF-joined ICS text
 */
export function buildEventIcs(event, { brandName = '', hostname = '' } = {}) {
  const brand = String(brandName || '').trim()
  const host = String(hostname || '').trim() || PLATFORM_HOST_SUFFIX
  const startMs = toMs(event?.startsAt)
  const endMsRaw = toMs(event?.endsAt)
  const endMs = Number.isFinite(endMsRaw) ? endMsRaw : startMs + DEFAULT_DURATION_MS
  const now = new Date()
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const title = String(event?.title || '').trim() || (brand ? `${brand} event` : 'Event')
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${PLATFORM_NAME}//Events//EN`,
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event?.id}@${host}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${floating(startMs)}`,
    `DTEND:${floating(endMs)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    event?.location ? `LOCATION:${escapeIcsText(event.location)}` : null,
    event?.description ? `DESCRIPTION:${escapeIcsText(event.description)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
}

/** The `href` for a client-side download of `ics`. */
export function eventIcsDataHref(ics) {
  return `data:text/calendar;charset=utf8,${encodeURIComponent(ics)}`
}

/**
 * Server-side: the identity the confirmed page hands RaceConfirmedPage for
 * the event behind `slug`. Never throws: an unknown slug, an unreadable
 * row or an unset app URL still yield a usable identity, because a buyer
 * who just paid must always get their calendar file.
 * @param {object|null} db service-role client
 * @param {string} slug   the live event slug (race_events.slug, unique, mig 451)
 * @returns {Promise<{ brandName: string, hostname: string }>}
 */
export async function resolveEventIcsIdentity(db, slug) {
  let brandName = ''
  let hostname = ''
  let locationId = null
  try {
    if (db && slug) {
      // .maybeSingle(): slug is globally unique (mig 451); 0 rows is "no such
      // event" — the page still renders, the widget shows its own not-found.
      const { data } = await db.from('race_events').select('location_id').eq('slug', slug).maybeSingle()
      locationId = data?.location_id || null
    }
    if (locationId) {
      const brand = await getLocationBranding(db, locationId)
      brandName = String(brand?.companyName || '').trim()
    }
  } catch {
    // brand stays '' — buildEventIcs falls back to a neutral summary
  }
  try {
    hostname = new URL(await resolveCustomerBaseUrl(db, locationId)).hostname
  } catch {
    hostname = PLATFORM_HOST_SUFFIX
  }
  return { brandName, hostname }
}
