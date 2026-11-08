// event-calendar-links — CALENDAR.1: "Add to calendar" for an event entry.
//
// The studio's wall clock (race_events.race_date + race_waves.start_time,
// local to locations.timezone) becomes a UTC instant through
// zonedWallClockToInstant (never `${date}T${time}Z`), the end is the start
// plus duration_minutes (null = 120 for a race, 60 otherwise), and two links
// come out: the .ics route (GET /api/public/events/<slug>/calendar.ics?wave=)
// and a Google Calendar template URL. The LOCATION text is the venue address,
// then the venue name, then the public location name: a host anchor's
// internal label never reaches a calendar (pickAudienceVenueName).
//
// Pure: no IO. The .ics route resolves the tenant identity and calls
// buildEventCalendarIcs; the emails, the confirmed page and the public event
// payload call eventCalendarLinks.

import { zonedWallClockToInstant } from '@shared/zoned-time'
import { isRaceKind } from '@shared/events'
import { buildIcsCalendar } from './ics'
import { pickAudienceVenueName } from './event-comms-location'
import { PLATFORM_NAME } from './brand-name'

const RACE_DEFAULT_MINUTES = 120
const OTHER_DEFAULT_MINUTES = 60

/** The stored duration, else the kind's default. */
export function eventDurationMinutes(event) {
  const n = Number(event?.duration_minutes)
  if (Number.isInteger(n) && n > 0) return n
  return isRaceKind(event?.kind) ? RACE_DEFAULT_MINUTES : OTHER_DEFAULT_MINUTES
}

/**
 * The UTC instant of a session: null without a date or a time.
 * @param {{ race_date: string|null, start_time: string|null, zone: string, durationMinutes: number }} args
 * @returns {{ startMs: number, endMs: number } | null}
 */
export function eventInstant({ race_date, start_time, zone, durationMinutes }) {
  if (!race_date || !start_time) return null
  const startMs = zonedWallClockToInstant(String(race_date).slice(0, 10), String(start_time).slice(0, 5), zone)
  if (!Number.isFinite(startMs)) return null
  const minutes = Number.isInteger(durationMinutes) && durationMinutes > 0 ? durationMinutes : OTHER_DEFAULT_MINUTES
  return { startMs, endMs: startMs + minutes * 60_000 }
}

/** Venue address → venue name → the public location name (never an anchor label). */
export function eventLocationText(event) {
  const address = typeof event?.venue_address === 'string' ? event.venue_address.trim() : ''
  if (address) return address
  return pickAudienceVenueName({ venueName: event?.venue_name, eventLocation: event?.locations }) || ''
}

const pad = (n) => String(n).padStart(2, '0')
/** 2026-07-18T09:00:00.000Z → 20260718T090000Z (Google's `dates=` format). */
function googleStamp(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

/** The wave to use: the one given, else the event's only wave. */
function pickWave(event, wave) {
  if (wave?.start_time) return { wave, explicit: true }
  const waves = Array.isArray(event?.waves) ? event.waves : []
  if (waves.length === 1 && waves[0]?.start_time) return { wave: waves[0], explicit: false }
  return { wave: null, explicit: false }
}

/**
 * The two links for one session, or null when the event has no instant.
 * @param {{ event: object, wave: object|null, zone: string, baseUrl: string }} args
 * @returns {{ ics_url: string, google_url: string, starts_at: string, ends_at: string } | null}
 */
export function eventCalendarLinks({ event, wave, zone, baseUrl }) {
  const picked = pickWave(event, wave)
  const instant = eventInstant({ race_date: event?.race_date, start_time: picked.wave?.start_time, zone, durationMinutes: eventDurationMinutes(event) })
  if (!instant) return null
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const ics = new URL(`${base}/api/public/events/${encodeURIComponent(event.slug)}/calendar.ics`)
  if (picked.explicit && picked.wave?.id) ics.searchParams.set('wave', picked.wave.id)
  const google = new URL('https://calendar.google.com/calendar/render')
  google.searchParams.set('action', 'TEMPLATE')
  google.searchParams.set('text', event.name || 'Event')
  google.searchParams.set('dates', `${googleStamp(instant.startMs)}/${googleStamp(instant.endMs)}`)
  const location = eventLocationText(event)
  if (location) google.searchParams.set('location', location)
  google.searchParams.set('details', `${base}/event/${encodeURIComponent(event.slug)}`)
  return {
    ics_url: ics.toString(),
    google_url: google.toString(),
    starts_at: new Date(instant.startMs).toISOString(),
    ends_at: new Date(instant.endMs).toISOString(),
  }
}

/**
 * The .ics file for one session (RFC 5545 via buildIcsCalendar: CRLF, folded,
 * UTC times). UID `<event id>-<wave id or 'event'>@<tenant host>`, so a
 * re-download updates the same calendar entry. null without an instant.
 */
export function buildEventCalendarIcs({ event, wave, zone, hostname, brandName, nowMs = Date.now() }) {
  const picked = pickWave(event, wave)
  const instant = eventInstant({ race_date: event?.race_date, start_time: picked.wave?.start_time, zone, durationMinutes: eventDurationMinutes(event) })
  if (!instant) return null
  const brand = String(brandName || '').trim()
  return buildIcsCalendar({
    prodId: `-//${PLATFORM_NAME}//Events//EN`,
    events: [{
      uid: `${event.id}-${picked.wave?.id || 'event'}@${hostname}`,
      dtstampMs: nowMs,
      startMs: instant.startMs,
      endMs: instant.endMs,
      summary: event.name || (brand ? `${brand} event` : 'Event'),
      location: eventLocationText(event) || null,
      description: brand ? `Booked at ${brand}` : null,
    }],
  })
}
