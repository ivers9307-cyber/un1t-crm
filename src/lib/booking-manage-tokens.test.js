// BOOKINGSELF.1 — the signed link that lets the person who booked cancel or
// reschedule (/book/manage/[token]). Round-trip, tamper, expiry, wrong secret,
// and that neither this token nor an entry-manage token passes as the other.

import { describe, it, expect, vi, afterEach } from 'vitest'
import crypto from 'node:crypto'
import {
  signBookingManageToken,
  verifyBookingManageToken,
  bookingManageUrl,
  BOOKING_MANAGE_TOKEN_TTL_MS,
} from './booking-manage-tokens.js'
import { signEntryManageToken, verifyEntryManageToken } from './entry-manage-tokens.js'
import { signCheckinToken } from './event-checkin-tokens.js'
import { signHostOnboardingToken } from './host-onboarding-tokens.js'

const SECRET = 'test-secret-123'
const BK = 'b0000000-0000-0000-0000-000000000001'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (payload, secret = SECRET) => crypto.createHmac('sha256', secret).update(payload).digest('base64url')

afterEach(() => { vi.unstubAllEnvs() })

describe('booking manage tokens', () => {
  it('round-trips a booking id as base64url payload.sig', () => {
    const t = signBookingManageToken({ bookingId: BK }, SECRET)
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verifyBookingManageToken(t, SECRET)).toEqual({ bookingId: BK })
  })

  it('is valid for 90 days', () => {
    expect(BOOKING_MANAGE_TOKEN_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })

  it('rejects a payload re-pointed at another booking under the old signature', () => {
    const t = signBookingManageToken({ bookingId: BK }, SECRET)
    const forged = b64({ b: 'someone-else', k: 'booking_manage', iat: Date.now() })
    expect(verifyBookingManageToken(`${forged}.${t.split('.')[1]}`, SECRET)).toBeNull()
  })

  it('rejects a bad signature, a wrong secret and an empty secret', () => {
    const t = signBookingManageToken({ bookingId: BK }, SECRET)
    expect(verifyBookingManageToken(`${t.split('.')[0]}.deadbeef`, SECRET)).toBeNull()
    expect(verifyBookingManageToken(t, 'another-secret')).toBeNull()
    expect(verifyBookingManageToken(t, '')).toBeNull()
    expect(verifyBookingManageToken(t, null)).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['one part', 'abc'],
    ['three parts', 'a.b.c'],
    ['an empty half', '.sig'],
  ])('rejects a malformed token (%s)', (_w, token) => {
    expect(verifyBookingManageToken(token, SECRET)).toBeNull()
  })

  it('expires after the TTL, and accepts it just before', () => {
    const now = Date.UTC(2026, 9, 11)
    const t = signBookingManageToken({ bookingId: BK }, SECRET, { nowMs: now })
    expect(verifyBookingManageToken(t, SECRET, { nowMs: now + BOOKING_MANAGE_TOKEN_TTL_MS - 1 })).toEqual({ bookingId: BK })
    expect(verifyBookingManageToken(t, SECRET, { nowMs: now + BOOKING_MANAGE_TOKEN_TTL_MS + 1 })).toBeNull()
  })

  it('rejects a token stamped in the future and one with no iat (fail closed)', () => {
    const now = Date.UTC(2026, 9, 11)
    const future = b64({ b: BK, k: 'booking_manage', iat: now + 10 * 60_000 })
    expect(verifyBookingManageToken(`${future}.${sign(future)}`, SECRET, { nowMs: now })).toBeNull()
    const unstamped = b64({ b: BK, k: 'booking_manage' })
    expect(verifyBookingManageToken(`${unstamped}.${sign(unstamped)}`, SECRET, { nowMs: now })).toBeNull()
  })

  it('an entry-manage token never verifies as a booking token, nor the reverse', () => {
    const entry = signEntryManageToken({ registrationId: BK }, SECRET)
    expect(verifyBookingManageToken(entry, SECRET)).toBeNull()
    const booking = signBookingManageToken({ bookingId: BK }, SECRET)
    expect(verifyEntryManageToken(booking, SECRET)).toBeNull()
  })

  it('a payload with the booking id under the entry key, or the wrong kind, is refused', () => {
    const wrongKind = b64({ b: BK, k: 'entry_manage', iat: Date.now() })
    expect(verifyBookingManageToken(`${wrongKind}.${sign(wrongKind)}`, SECRET)).toBeNull()
    const entryShape = b64({ r: BK, k: 'booking_manage', iat: Date.now() })
    expect(verifyBookingManageToken(`${entryShape}.${sign(entryShape)}`, SECRET)).toBeNull()
  })

  it('never accepts another kind of token signed with the same key', () => {
    const checkin = signCheckinToken({ eventId: 'e1', registrationId: BK, memberId: 'm1' }, SECRET)
    const host = signHostOnboardingToken({ hostId: BK }, SECRET)
    expect(verifyBookingManageToken(checkin, SECRET)).toBeNull()
    expect(verifyBookingManageToken(host, SECRET)).toBeNull()
  })

  it('refuses to sign with no secret or no id', () => {
    expect(() => signBookingManageToken({ bookingId: BK }, '')).toThrow()
    expect(() => signBookingManageToken({ bookingId: '' }, SECRET)).toThrow()
  })
})

describe('bookingManageUrl', () => {
  it('is the app origin + /book/manage/<token>, signed with the service-role key', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test/')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
    const url = bookingManageUrl(BK)
    expect(url).toMatch(/^https:\/\/crm\.test\/book\/manage\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verifyBookingManageToken(url.split('/').pop(), SECRET)).toEqual({ bookingId: BK })
  })

  it('mints on a handed-in customer host (trailing slash dropped)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
    expect(bookingManageUrl(BK, { baseUrl: 'https://gym-a.repset.ie/' })).toMatch(/^https:\/\/gym-a\.repset\.ie\/book\/manage\//)
  })

  it('is null (no link) without a key, an app url or an id, and never throws', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(bookingManageUrl(BK)).toBeNull()
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
    expect(bookingManageUrl(null)).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(bookingManageUrl(BK)).toBeNull()
  })
})
