// ICSFEED.1 — the calendar link's credential: shape, hash, URL. Mirrors
// src/lib/widget-token.js on purpose (mig 607's model).

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CALENDAR_FEED_TOKEN_PREFIX, CALENDAR_FEED_PATH,
  generateCalendarFeedToken, hashCalendarFeedToken, tokenFromFeedFile, calendarFeedUrls,
} from './calendar-feed-token'

const TOKEN = `rcf_${'A'.repeat(43)}`

describe('generateCalendarFeedToken', () => {
  it('is rcf_ + 43 base64url characters (32 random bytes), and never repeats', () => {
    const a = generateCalendarFeedToken()
    const b = generateCalendarFeedToken()
    expect(a).toMatch(/^rcf_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(CALENDAR_FEED_TOKEN_PREFIX).toBe('rcf_')
  })
})

describe('hashCalendarFeedToken', () => {
  it('is the sha256 hex of the whole token', () => {
    expect(hashCalendarFeedToken(TOKEN)).toBe(createHash('sha256').update(TOKEN).digest('hex'))
    expect(hashCalendarFeedToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('refuses anything that is not exactly a calendar token, before any lookup', () => {
    for (const bad of [null, undefined, 42, '', 'rcf_', `rwt_${'A'.repeat(43)}`, `rcf_${'A'.repeat(42)}`,
      `rcf_${'A'.repeat(44)}`, `${TOKEN}.ics`, `rcf_${'A'.repeat(42)}=`, `rcf_${'A'.repeat(42)}/`]) {
      expect(hashCalendarFeedToken(bad), String(bad)).toBe(null)
    }
  })
})

describe('tokenFromFeedFile (the [file] path segment)', () => {
  it('takes the token with or without .ics', () => {
    expect(tokenFromFeedFile(`${TOKEN}.ics`)).toBe(TOKEN)
    expect(tokenFromFeedFile(TOKEN)).toBe(TOKEN)
  })
  it('refuses everything else', () => {
    for (const bad of [null, '', 'feed.ics', `${TOKEN}.ics.ics`, `${TOKEN}.txt`, `../${TOKEN}.ics`, '%E0%A4%A.ics']) {
      expect(tokenFromFeedFile(bad), String(bad)).toBe(null)
    }
  })
})

describe('calendarFeedUrls', () => {
  it('builds the https, webcal and Google add-by-URL links from the app origin', () => {
    const urls = calendarFeedUrls('https://crm.example.test/', TOKEN)
    expect(urls.url).toBe(`https://crm.example.test${CALENDAR_FEED_PATH}/${TOKEN}.ics`)
    expect(urls.webcal_url).toBe(`webcal://crm.example.test/api/calendar-feed/${TOKEN}.ics`)
    expect(urls.google_url).toBe(
      `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(urls.webcal_url)}`,
    )
  })
})
