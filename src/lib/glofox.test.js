import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyGlofoxSignature, parseGlofoxEvent, tagsForGlofoxEvent, generateGlofoxPasscode, purchaseGlofoxMembership, createGlofoxInteraction, interpretBookingResult } from './glofox.js'

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyGlofoxSignature', () => {
  const secret = 'test-secret-123'
  const body = JSON.stringify({ event_type: 'booking.created', data: { id: 'b1' } })

  it('returns true for a valid signature', () => {
    const sig = sign(secret, body)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: sig, secret })).toBe(true)
  })

  it('returns false for a tampered body', () => {
    const sig = sign(secret, body)
    const tampered = body.replace('b1', 'b2')
    expect(verifyGlofoxSignature({ rawBody: tampered, signatureHeader: sig, secret })).toBe(false)
  })

  it('returns false for a wrong secret', () => {
    const sig = sign('different-secret', body)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: sig, secret })).toBe(false)
  })

  it('returns false for missing arguments', () => {
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: '', secret })).toBe(false)
    expect(verifyGlofoxSignature({ rawBody: '', signatureHeader: 'x', secret })).toBe(false)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: 'x', secret: '' })).toBe(false)
  })

  it('returns false for length-mismatch signature (no timingSafeEqual throw)', () => {
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: 'short', secret })).toBe(false)
  })

  it('rejects non-string inputs', () => {
    expect(verifyGlofoxSignature({ rawBody: { not: 'a string' }, signatureHeader: 'x', secret })).toBe(false)
    expect(verifyGlofoxSignature({ rawBody: body, signatureHeader: 123, secret })).toBe(false)
  })
})

describe('parseGlofoxEvent', () => {
  it('returns all-nulls for a non-object payload', () => {
    expect(parseGlofoxEvent(null)).toEqual({
      eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null, userId: null,
    })
    expect(parseGlofoxEvent('string')).toEqual({
      eventId: null, eventType: null, branchId: null, entityId: null, contactEmail: null, userId: null,
    })
  })

  it('extracts top-level fields', () => {
    const payload = {
      event_id: 'evt_123',
      event_type: 'booking.created',
      branch_id: 'br1',
      data: { id: 'b1', email: 'me@example.com' },
    }
    expect(parseGlofoxEvent(payload)).toEqual({
      eventId: 'evt_123',
      eventType: 'booking.created',
      branchId: 'br1',
      entityId: 'b1',
      contactEmail: 'me@example.com',
      // entityId is 'b1' (data.id), and the userId fallback path
      // ['data', 'id'] sits last so it ALSO resolves to 'b1' for
      // member-shaped payloads. That's fine — for booking payloads
      // a separate ['data', 'user_id'] path takes precedence (see
      // the BOOKING_CREATED test below).
      userId: 'b1',
    })
  })

  it('handles camelCase variations', () => {
    const payload = {
      eventId: 'evt_123',
      eventType: 'membership.created',
      branchId: 'br1',
      data: { id: 'm1', email: 'A@B.COM' },
    }
    const out = parseGlofoxEvent(payload)
    expect(out.eventId).toBe('evt_123')
    expect(out.eventType).toBe('membership.created')
    expect(out.branchId).toBe('br1')
    expect(out.entityId).toBe('m1')
    // Email is normalised to lowercase + trimmed
    expect(out.contactEmail).toBe('a@b.com')
  })

  it('falls back through multiple email paths', () => {
    expect(parseGlofoxEvent({ data: { member_email: 'm@x.com' } }).contactEmail).toBe('m@x.com')
    expect(parseGlofoxEvent({ data: { member: { email: 'n@x.com' } } }).contactEmail).toBe('n@x.com')
    expect(parseGlofoxEvent({ data: { user: { email: 'u@x.com' } } }).contactEmail).toBe('u@x.com')
    expect(parseGlofoxEvent({ data: { customer: { email: 'c@x.com' } } }).contactEmail).toBe('c@x.com')
  })

  it('returns null fields when nothing matches', () => {
    const out = parseGlofoxEvent({ random: 'object' })
    expect(out.eventType).toBeNull()
    expect(out.contactEmail).toBeNull()
  })

  it('coerces non-string ids to strings', () => {
    const out = parseGlofoxEvent({ id: 12345, type: 'x' })
    expect(out.eventId).toBe('12345')
  })

  it('treats empty string as missing', () => {
    expect(parseGlofoxEvent({ event_id: '', event_type: 'x' }).eventId).toBeNull()
  })

  // GLOFOX5.1 — real Glofox webhook payloads. The envelope is
  // { Type, Payload, Metadata, Timestamp } with capitalised keys.
  // Captured from the production webhook audit on 2026-05-12.
  describe('real Glofox payload shapes', () => {
    it('parses a BOOKING_CREATED payload — uses Payload.user_id for userId, no email', () => {
      const payload = {
        Type: 'BOOKING_CREATED',
        Payload: {
          id: '6a036003fd8a06e397010ce2',
          status: 'BOOKED',
          user_id: '690f97ca89ac348de005a5d7',
          model_id: '69f0fe43362701c4260529a8',
          time_start: '2026-05-12T18:00:00Z',
        },
        Metadata: { location_id: '6155764859810329ec3826b3', trace_id: 'abc' },
      }
      const out = parseGlofoxEvent(payload)
      expect(out.eventType).toBe('BOOKING_CREATED')
      expect(out.branchId).toBe('6155764859810329ec3826b3')
      expect(out.entityId).toBe('6a036003fd8a06e397010ce2')
      // Critical: BOOKING_* payloads carry NO email — must surface
      // the user_id so the receiver can fall back to a contacts
      // lookup by glofox_member_id.
      expect(out.contactEmail).toBeNull()
      expect(out.userId).toBe('690f97ca89ac348de005a5d7')
    })

    it('parses a MEMBER_UPDATED payload — both email AND Payload.id as userId', () => {
      const payload = {
        Type: 'MEMBER_UPDATED',
        Payload: {
          id: '6536875250972466f2067af3',
          email: 'clareconnolly8@gmail.com',
          first_name: 'Clare',
          last_name: 'Connolly',
        },
        Metadata: { location_id: '6155764859810329ec3826b3' },
      }
      const out = parseGlofoxEvent(payload)
      expect(out.contactEmail).toBe('clareconnolly8@gmail.com')
      // For MEMBER_* events the member IS the entity — entity_id
      // and user_id are the same. Receiver uses email first, falls
      // back to user_id if not found.
      expect(out.userId).toBe('6536875250972466f2067af3')
      expect(out.entityId).toBe('6536875250972466f2067af3')
    })

    it('parses an INVOICE_UPDATED payload — Payload.user.email + Payload.user.id', () => {
      const payload = {
        Type: 'INVOICE_UPDATED',
        Payload: {
          id: '376fa1bf-fb31-451a-b7f2-0dd670d7b77f',
          status: 'PAID',
          user: {
            id: '658b300f48e87a159508c8e7',
            email: 'skhongoroo@yahoo.ie',
            first_name: 'Natasha',
            last_name: 'Shijirbaatar',
          },
        },
        Metadata: { location_id: '6155764859810329ec3826b3' },
      }
      const out = parseGlofoxEvent(payload)
      expect(out.contactEmail).toBe('skhongoroo@yahoo.ie')
      expect(out.userId).toBe('658b300f48e87a159508c8e7')
    })

    it('parses a MEMBERSHIP_UPDATED payload — only Payload.user_id (no email)', () => {
      const payload = {
        Type: 'MEMBERSHIP_UPDATED',
        Payload: {
          id: '65bbba6cfcfa171af06b5717',
          status: 'ACTIVE',
          user_id: '658b300f48e87a159508c8e7',
          membership_definition: { id: '659442d20e66eb19f0074532', type: 'TIME' },
        },
        Metadata: { location_id: '6155764859810329ec3826b3' },
      }
      const out = parseGlofoxEvent(payload)
      expect(out.contactEmail).toBeNull()
      // Critical: lookup-by-glofox_member_id is the only way to
      // find the contact for MEMBERSHIP_* events.
      expect(out.userId).toBe('658b300f48e87a159508c8e7')
    })

    it('parses a SERVICE_UPDATED payload — lowercase metadata/payload, member_ids[0] as userId', () => {
      // GLOFOX-REACTIVE: SERVICE_* events use lowercase keys and link
      // to the member via a member_ids ARRAY (no email). The parser
      // must resolve member_ids[0] via array-index path so the
      // receiver's glofox_member_id fallback finds the contact, and
      // must use metadata.trace_id (NOT the stable service id) as the
      // dedup key so a pause→resume update isn't dropped.
      const payload = {
        type: 'SERVICE_UPDATED',
        metadata: { trace_id: 'svc-trace-9', location_id: '6155764859810329ec3826b3', version: '1' },
        timestamp: '2026-07-20T10:00:00Z',
        payload: {
          id: 'svc_abc',
          membership_id: 'mem_1',
          member_ids: ['658b300f48e87a159508c8e7'],
          status: 'active',
          pause: { start_date: '2026-07-15T00:00:00Z', duration_unit: 'week', duration_amount: 4, resume_date: '2026-08-15T00:00:00Z' },
        },
      }
      const out = parseGlofoxEvent(payload)
      expect(out.eventType).toBe('SERVICE_UPDATED')
      expect(out.branchId).toBe('6155764859810329ec3826b3')
      expect(out.eventId).toBe('svc-trace-9') // trace_id, not the service id
      expect(out.entityId).toBe('svc_abc')
      expect(out.contactEmail).toBeNull()
      expect(out.userId).toBe('658b300f48e87a159508c8e7') // member_ids[0]
    })

    it('parses Payload.contact_email as a fallback for MEMBER payloads', () => {
      // Some Glofox MEMBER payloads carry contact_email separately
      // from email — capture both. The email path resolves first;
      // contact_email is the last-resort fallback.
      const payload = {
        Type: 'MEMBER_UPDATED',
        Payload: { id: 'm1', contact_email: 'fallback@x.com' },
      }
      expect(parseGlofoxEvent(payload).contactEmail).toBe('fallback@x.com')
    })
  })
})

describe('tagsForGlofoxEvent', () => {
  // GLOFOX2.1.12 — canonical Glofox event_type strings are
  // UPPERCASE_SNAKE_CASE per openapi.yaml (MEMBER_CREATED,
  // BOOKING_DELETED, etc.). The dotted-lowercase form is kept
  // as backward-compatible aliases.

  it('maps canonical UPPERCASE_SNAKE_CASE event types', () => {
    expect(tagsForGlofoxEvent('BOOKING_CREATED')).toEqual(['glofox_booking_created'])
    expect(tagsForGlofoxEvent('BOOKING_DELETED')).toEqual(['glofox_booking_cancelled'])
    expect(tagsForGlofoxEvent('BOOKING_UPDATED')).toEqual(['glofox_booking_updated'])
    expect(tagsForGlofoxEvent('MEMBER_CREATED')).toEqual(['glofox_member_created'])
    expect(tagsForGlofoxEvent('MEMBER_UPDATED')).toEqual(['glofox_member_updated'])
    expect(tagsForGlofoxEvent('MEMBERSHIP_CREATED')).toEqual(['glofox_membership_created'])
    expect(tagsForGlofoxEvent('MEMBERSHIP_UPDATED')).toEqual(['glofox_membership_updated'])
    expect(tagsForGlofoxEvent('MEMBERSHIP_DELETED')).toEqual(['glofox_membership_deleted'])
  })

  it('handles new event families added in GLOFOX2.1.12', () => {
    expect(tagsForGlofoxEvent('COURSE_BOOKING_CREATED')).toEqual(['glofox_course_booking_created'])
    expect(tagsForGlofoxEvent('COURSE_BOOKING_DELETED')).toEqual(['glofox_course_booking_cancelled'])
    expect(tagsForGlofoxEvent('INVOICE_UPDATED')).toEqual(['glofox_invoice_updated'])
  })

  it('handles access (barcode) events with the spec-named MEMBER_ACCESS_INFO_* keys', () => {
    expect(tagsForGlofoxEvent('MEMBER_ACCESS_INFO_CREATED')).toEqual(['glofox_access_created'])
    expect(tagsForGlofoxEvent('MEMBER_ACCESS_INFO_UPDATED')).toEqual(['glofox_access_updated'])
  })

  it('legacy dotted-lowercase aliases still map to canonical tags', () => {
    expect(tagsForGlofoxEvent('booking.created')).toEqual(['glofox_booking_created'])
    expect(tagsForGlofoxEvent('member.created')).toEqual(['glofox_member_created'])
    expect(tagsForGlofoxEvent('membership.cancelled')).toEqual(['glofox_membership_deleted'])
  })

  it('legacy US-spelling cancellations still alias correctly', () => {
    expect(tagsForGlofoxEvent('booking.canceled')).toEqual(['glofox_booking_cancelled'])
    expect(tagsForGlofoxEvent('membership.canceled')).toEqual(['glofox_membership_deleted'])
  })

  it('returns empty array for unknown event types', () => {
    expect(tagsForGlofoxEvent('something.weird')).toEqual([])
    expect(tagsForGlofoxEvent('SOMETHING_WEIRD')).toEqual([])
    expect(tagsForGlofoxEvent('')).toEqual([])
    expect(tagsForGlofoxEvent(null)).toEqual([])
    expect(tagsForGlofoxEvent(undefined)).toEqual([])
  })

  it('normalises lowercase / dashes / mixed-case to canonical form', () => {
    expect(tagsForGlofoxEvent('booking_created')).toEqual(['glofox_booking_created'])
    expect(tagsForGlofoxEvent('booking-created')).toEqual(['glofox_booking_created'])
    expect(tagsForGlofoxEvent('Booking_Created')).toEqual(['glofox_booking_created'])
  })

  it('returns a fresh array per call (caller can mutate without poisoning)', () => {
    const a = tagsForGlofoxEvent('BOOKING_CREATED')
    const b = tagsForGlofoxEvent('BOOKING_CREATED')
    expect(a).not.toBe(b)
    a.push('extra')
    expect(b).toEqual(['glofox_booking_created'])
  })
})

describe('computeGlofoxBackoffMs', () => {
  it('honours a numeric Retry-After (seconds -> ms, capped 30s)', async () => {
    const { computeGlofoxBackoffMs } = await import('./glofox.js')
    expect(computeGlofoxBackoffMs(0, 2)).toBe(2000)
    expect(computeGlofoxBackoffMs(0, 120)).toBe(30_000) // capped
  })

  it('falls back to exponential backoff with jitter when no Retry-After', async () => {
    const { computeGlofoxBackoffMs } = await import('./glofox.js')
    const a0 = computeGlofoxBackoffMs(0, null)
    const a2 = computeGlofoxBackoffMs(2, null)
    expect(a0).toBeGreaterThanOrEqual(500)
    expect(a0).toBeLessThan(750)
    expect(a2).toBeGreaterThanOrEqual(2000) // 500 * 2^2
    expect(a2).toBeLessThan(2250)
  })
})

describe('glofoxFetch 429/5xx backoff (via fetchMemberResult)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  })
  const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }

  it('retries a 429 then succeeds within the same call', async () => {
    const { fetchMemberResult } = await import('./glofox.js')
    global.fetch
      .mockResolvedValueOnce(res(429, {}))
      .mockResolvedValueOnce(res(200, { data: { _id: 'g1' } }))
    const out = await fetchMemberResult(creds, 'g1')
    expect(out).toMatchObject({ ok: true, member: { _id: 'g1' } })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('retries 5xx up to the budget then gives up (ok:false)', async () => {
    const { fetchMemberResult } = await import('./glofox.js')
    global.fetch.mockResolvedValue(res(500, {}))
    const out = await fetchMemberResult(creds, 'g1')
    expect(out).toMatchObject({ ok: false, member: null })
    // initial attempt + GLOFOX_MAX_RETRIES (3) = 4 calls
    expect(global.fetch).toHaveBeenCalledTimes(4)
  })

  it('does not retry a 404 — returns immediately', async () => {
    const { fetchMemberResult } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(404, {}))
    const out = await fetchMemberResult(creds, 'gX')
    expect(out).toMatchObject({ ok: false, member: null })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('registerGlofoxMember content-type', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })
  const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }

  // Regression: without Content-Type: application/json the body went as
  // text/plain, Glofox never parsed it, and every field came back "required" —
  // so no member was created and the booking dead-ended in staff review.
  it('POSTs /register as application/json with the fields in the body', async () => {
    const { registerGlofoxMember } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { user: { _id: 'gm1' } }))
    const out = await registerGlofoxMember(creds, { first_name: 'Sam', last_name: 'Lee', email: 'Sam@X.com', password: 'Abcd-1234' })
    expect(out.ok).toBe(true)
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toContain('/2.0/register')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toMatchObject({ first_name: 'Sam', last_name: 'Lee', email: 'sam@x.com' })
  })

  it('POSTs the membership purchase as application/json', async () => {
    global.fetch.mockResolvedValueOnce(res(200, { ok: true }))
    const out = await purchaseGlofoxMembership(creds, 'u1', 'm1', 'p1')
    expect(out.ok).toBe(true)
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toContain('/purchase')
    expect(init.headers['Content-Type']).toBe('application/json')
  })
})

describe('generateGlofoxPasscode (Glofox password policy)', () => {
  // Regression for the live PASSWORD_RULE_LOWER_CASE failure: the old
  // uppercase+digits-only alphabet could never produce a lowercase letter, so
  // Glofox rejected every new-member registration. Every output must now carry
  // one of each class Glofox checks.
  it('guarantees lowercase + uppercase + digit + hyphen on every output (500 runs)', () => {
    for (let i = 0; i < 500; i++) {
      const p = generateGlofoxPasscode()
      expect(p, `lowercase missing in "${p}"`).toMatch(/[a-z]/)
      expect(p, `uppercase missing in "${p}"`).toMatch(/[A-Z]/)
      expect(p, `digit missing in "${p}"`).toMatch(/[0-9]/)
      expect(p, `hyphen missing in "${p}"`).toContain('-')
      expect(p).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/)
      // readability: no visually-ambiguous chars
      expect(p, `ambiguous char in "${p}"`).not.toMatch(/[0O1Il]/)
    }
  })

  it('is high-entropy (mostly distinct across 500 runs)', () => {
    const seen = new Set()
    for (let i = 0; i < 500; i++) seen.add(generateGlofoxPasscode())
    expect(seen.size).toBeGreaterThan(490)
  })
})

describe('createGlofoxInteraction', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const creds = { branchId: 'b'.repeat(24), apiKey: 'k', apiToken: 't' }
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body })

  it('POSTs to the interactions endpoint with user_id, type, description', async () => {
    global.fetch.mockResolvedValueOnce(res(200, {}))
    const uid = 'a'.repeat(24)
    const r = await createGlofoxInteraction(creds, uid, { type: 'NOTE', description: 'hi' })
    expect(r.ok).toBe(true)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toContain(`/2.1/branches/${creds.branchId}/leads/${uid}/interactions`)
    expect(opts.method).toBe('POST')
    // Content-Type is required or Glofox rejects the body as text/plain.
    expect(opts.headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(opts.body)
    expect(sent).toMatchObject({ user_id: uid, type: 'NOTE', description: 'hi' })
  })

  it('returns { ok:false } on missing creds/userId (no throw)', async () => {
    expect((await createGlofoxInteraction(null, 'x', { type: 'NOTE', description: 'y' })).ok).toBe(false)
    expect((await createGlofoxInteraction(creds, '', { type: 'NOTE', description: 'y' })).ok).toBe(false)
  })
})

describe('interpretBookingResult (MIA-BOOK.1)', () => {
  const call = (over) => interpretBookingResult({ ok: true, status: 200, body: {}, ...over })
  it('2xx with a booking id is a success (all harvest shapes)', () => {
    expect(call({ body: { id: 'b1' } })).toMatchObject({ success: true, bookingId: 'b1' })
    expect(call({ body: { _id: 'b2' } }).bookingId).toBe('b2')
    expect(call({ body: { booking_id: 'b3' } }).bookingId).toBe('b3')
    expect(call({ body: { data: { id: 'b4' } } }).bookingId).toBe('b4')
  })
  it('a clean 2xx with no code and no id still succeeds', () => {
    expect(call({ body: {} })).toMatchObject({ success: true, bookingId: null, messageCode: null })
    expect(call({ body: null })).toMatchObject({ success: true })
  })
  it('the live-observed 200 + YOU_HAVE_NO_CREDITS_LEFT shape is a FAILURE', () => {
    expect(call({ body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } }))
      .toMatchObject({ success: false, messageCode: 'YOU_HAVE_NO_CREDITS_LEFT' })
  })
  it('an unknown code on a 2xx without a booking id fails safe', () => {
    expect(call({ body: { message_code: 'SOME_NEW_CODE' } }).success).toBe(false)
  })
  it('a code accompanied by a booking id stays a success', () => {
    expect(call({ body: { message_code: 'ANYTHING', id: 'b1' } }).success).toBe(true)
  })
  it('already-booked is a success even on a non-2xx', () => {
    expect(call({ ok: false, status: 422, body: { message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } }))
      .toMatchObject({ success: true, alreadyBooked: true })
  })
  it('non-2xx / network shapes are failures', () => {
    expect(call({ ok: false, status: 500, body: { error: 'boom' } }).success).toBe(false)
    expect(interpretBookingResult({ ok: false, status: 0, body: { error: 'network error' } }).success).toBe(false)
    expect(interpretBookingResult(null).success).toBe(false)
  })
})
