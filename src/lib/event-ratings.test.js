// HOSTPAGE.2 — rating tokens (30-day HMAC links), the public summary rule
// (3+ public ratings) and the request email's default copy.
import { describe, it, expect } from 'vitest'
import {
  signRatingToken, verifyRatingToken, ratingUrl, ratingSummary, ratingRequestDefaults, RATING_TOKEN_TTL_MS,
} from './event-ratings'

const R = '80000000-0000-4000-8000-000000000001'
const E = 'e0000000-0000-4000-8000-0000000000e1'
const NOW = Date.parse('2026-07-19T08:00:00Z')
const DAY = 86_400_000

describe('rating tokens', () => {
  it('round-trip, reject a tampered signature, another secret, a malformed token and an expired one', () => {
    const t = signRatingToken({ registrationId: R, eventId: E }, 's3cret', { nowMs: NOW })
    expect(verifyRatingToken(t, 's3cret', { nowMs: NOW })).toEqual({ registrationId: R, eventId: E })
    expect(verifyRatingToken(t.slice(0, -2) + 'zz', 's3cret', { nowMs: NOW })).toBeNull()
    expect(verifyRatingToken(t, 'other', { nowMs: NOW })).toBeNull()
    expect(verifyRatingToken('nope', 's3cret', { nowMs: NOW })).toBeNull()
    expect(verifyRatingToken(t, 's3cret', { nowMs: NOW + 29 * DAY })).toEqual({ registrationId: R, eventId: E })
    expect(verifyRatingToken(t, 's3cret', { nowMs: NOW + 31 * DAY })).toBeNull()
    expect(RATING_TOKEN_TTL_MS).toBe(30 * DAY)
  })
  it('a token for another kind of link does not verify as a rating token', () => {
    const payload = Buffer.from(JSON.stringify({ r: R, k: 'entry_manage', iat: NOW })).toString('base64url')
    const { createHmac } = require('node:crypto')
    const sig = Buffer.from(createHmac('sha256', 's3cret').update(payload).digest()).toString('base64url')
    expect(verifyRatingToken(`${payload}.${sig}`, 's3cret', { nowMs: NOW })).toBeNull()
  })
  it('ratingUrl builds /event/rate/<token> on the given base, or null without a secret', () => {
    const prev = process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.SUPABASE_SERVICE_ROLE_KEY = 's3cret'
    const url = ratingUrl({ registrationId: R, eventId: E, baseUrl: 'https://un1t.repset.ie/' })
    expect(url.startsWith('https://un1t.repset.ie/event/rate/')).toBe(true)
    expect(verifyRatingToken(url.split('/event/rate/')[1], 's3cret')).toEqual({ registrationId: R, eventId: E })
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(ratingUrl({ registrationId: R, eventId: E, baseUrl: 'https://x' })).toBeNull()
    if (prev !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prev
  })
})

describe('ratingSummary', () => {
  const row = (rating, comment, created_at, is_public = true, first_name = 'Aoife') => ({ rating, comment, created_at, is_public, contact: { first_name } })
  it('null under three public ratings (hidden ones do not count)', () => {
    expect(ratingSummary([row(5, 'a', '2026-07-01'), row(4, 'b', '2026-07-02')])).toBeNull()
    expect(ratingSummary([row(5, 'a', '2026-07-01'), row(4, 'b', '2026-07-02'), row(1, 'c', '2026-07-03', false)])).toBeNull()
    expect(ratingSummary([])).toBeNull()
  })
  it('average to one decimal over public ratings, count, and the three newest non-empty public comments with first names', () => {
    const rows = [
      row(5, 'Loved it', '2026-07-01T10:00:00Z'),
      row(4, '', '2026-07-02T10:00:00Z'),
      row(4, 'Good', '2026-07-03T10:00:00Z', true, null),
      row(1, 'Hidden rant', '2026-07-04T10:00:00Z', false),
      row(5, 'Brilliant', '2026-07-05T10:00:00Z', true, 'Dan'),
      row(3, 'Fine', '2026-07-06T10:00:00Z', true, 'Sé'),
    ]
    const s = ratingSummary(rows)
    expect(s.average).toBe(4.2) // (5+4+4+5+3)/5
    expect(s.count).toBe(5)
    expect(s.comments).toEqual([
      { rating: 3, comment: 'Fine', author: 'Sé', created_at: '2026-07-06T10:00:00Z' },
      { rating: 5, comment: 'Brilliant', author: 'Dan', created_at: '2026-07-05T10:00:00Z' },
      { rating: 4, comment: 'Good', author: '', created_at: '2026-07-03T10:00:00Z' },
    ])
  })
})

describe('ratingRequestDefaults', () => {
  it('names the event and the host, escapes them, and links the rate page', () => {
    const d = ratingRequestDefaults({ eventName: 'Mobility <Workshop>', hostName: 'Acme & Co', rateUrl: 'https://un1t.repset.ie/event/rate/t' })
    expect(d.subject).toBe('How was Mobility <Workshop>?')
    expect(d.introHtml).toContain('Mobility &lt;Workshop&gt;')
    expect(d.introHtml).toContain('Acme &amp; Co')
    expect(d.afterInfoHtml).toContain('href="https://un1t.repset.ie/event/rate/t"')
    expect(d.afterInfoHtml).toContain('Rate Mobility &lt;Workshop&gt;')
  })
})
