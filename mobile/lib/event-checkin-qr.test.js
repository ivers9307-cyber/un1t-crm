import { describe, it, expect } from 'vitest'
import { parseCheckinQr } from './event-checkin-qr'

const ORIGIN = 'https://crm.un1tdublin.com'
const EVENT = '11111111-1111-1111-1111-111111111111'
// base64url payload.sig — the shape signCheckinToken emits (chars are URL-safe).
const TOKEN = 'eyJlIjoiYWJjIiwiciI6IjEiLCJtIjoiMiJ9.c2lnbmF0dXJlLWJ5dGVz'

describe('parseCheckinQr', () => {
  it('extracts eventId and token from a check-in scan URL', () => {
    const data = `${ORIGIN}/events/${EVENT}/checkin/scan?t=${TOKEN}`
    expect(parseCheckinQr(data)).toEqual({ eventId: EVENT, token: TOKEN })
  })

  it('trims surrounding whitespace a QR decoder may append', () => {
    const data = `  ${ORIGIN}/events/${EVENT}/checkin/scan?t=${TOKEN}\n`
    expect(parseCheckinQr(data)).toEqual({ eventId: EVENT, token: TOKEN })
  })

  it('returns null when the token query param is missing', () => {
    expect(parseCheckinQr(`${ORIGIN}/events/${EVENT}/checkin/scan`)).toBeNull()
  })

  it('returns null for a URL that is not a check-in scan link', () => {
    expect(parseCheckinQr(`${ORIGIN}/events/${EVENT}/tv?t=${TOKEN}`)).toBeNull()
  })

  it('returns null for a bare token with no URL around it', () => {
    expect(parseCheckinQr(TOKEN)).toBeNull()
  })

  it('returns null for empty or non-string input', () => {
    expect(parseCheckinQr('')).toBeNull()
    expect(parseCheckinQr(null)).toBeNull()
    expect(parseCheckinQr(undefined)).toBeNull()
    expect(parseCheckinQr(42)).toBeNull()
  })
})
