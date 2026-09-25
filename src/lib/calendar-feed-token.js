// src/lib/calendar-feed-token.js
// ICSFEED.1 — the calendar link's credential, in one place. Server-only
// (node:crypto). Same model as src/lib/widget-token.js and mig 607:
//
//   • the token is rcf_ + 32 CSPRNG bytes (base64url, 43 chars), shown to the
//     person ONCE, never stored, never logged;
//   • only its sha256 is stored (staff_calendar_feeds.token_hash, mig 632).
//     Plain sha256 with no salt is correct for 256 random bits: there is no
//     dictionary to stretch against, this is a lookup key. Looking the HASH up
//     by a unique index is the constant-time compare: the plaintext is never
//     compared against anything.
//   • the rcf_ prefix lets hashCalendarFeedToken refuse a non-token before any
//     database call, and makes a pasted link recognisable in a support thread.

import { createHash, randomBytes } from 'node:crypto'

export const CALENDAR_FEED_TOKEN_PREFIX = 'rcf_'
export const CALENDAR_FEED_PATH = '/api/calendar-feed'

const TOKEN_RE = /^rcf_[A-Za-z0-9_-]{43}$/
const FILE_RE = /^(rcf_[A-Za-z0-9_-]{43})(?:\.ics)?$/

/** A new plaintext token. Returned to the person ONCE. */
export function generateCalendarFeedToken() {
  return CALENDAR_FEED_TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/** sha256 hex of a calendar token, or null for anything that is not exactly one. */
export function hashCalendarFeedToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
  return createHash('sha256').update(token).digest('hex')
}

/** The token inside the route's [file] segment (`<token>.ics` or `<token>`), else null. */
export function tokenFromFeedFile(file) {
  if (typeof file !== 'string' || !file) return null
  let s
  try {
    s = decodeURIComponent(file)
  } catch {
    return null
  }
  const m = s.match(FILE_RE)
  return m ? m[1] : null
}

/**
 * The three links a person is given. Built HERE and nowhere else, so the web
 * card and the phone can never disagree about a URL.
 *   url         https — paste into any calendar app
 *   webcal_url  webcal:// — Apple Calendar and Outlook open a subscribe dialog
 *   google_url  Google Calendar's add-by-URL page (Android has no webcal handler)
 */
export function calendarFeedUrls(baseUrl, token) {
  const origin = String(baseUrl).replace(/\/+$/, '')
  const url = `${origin}${CALENDAR_FEED_PATH}/${token}.ics`
  const webcalUrl = url.replace(/^https?:\/\//i, 'webcal://')
  return {
    url,
    webcal_url: webcalUrl,
    google_url: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`,
  }
}
