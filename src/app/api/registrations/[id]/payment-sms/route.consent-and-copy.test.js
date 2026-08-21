// POST /api/registrations/[id]/payment-sms — audit item 7a, D1 + D2 + D3.
//
// Every test here pins WHO receives WHAT, FROM WHICH SENDER.
//
// These are BEHAVIOURAL against main, not symbol-level: both module factories
// below are partial (`importOriginal`), so main's route — which imports
// `resolveSenderLocation` rather than `resolveTenantSmsSender` — still resolves
// every import and runs to the assertion.
//
// VERIFIED, not asserted: `git archive origin/main` into a scratch tree with
// node_modules symlinked, this file dropped in unchanged, `npx vitest run` →
// 6 failed | 4 passed, and all six are AssertionErrors on the defect itself:
//
//   expected 'Hi A, here's your link to pay €25.00…' not to contain '(host events)'
//   expected … to contain '— UN1T Stillorgan'
//   expected … to contain '— UN1T STILLORGAN'
//   expected 200 to be 400   (administrative SMS opt-out — main texts anyway)
//   expected 200 to be 400   (sms_status opted_out/invalid — main texts anyway)
//   expected 200 to be 409   (no tenant sender — main texts from CCF Autos)
//
// The four that PASS against main are the ones asserting behaviour main already
// has (a normal send still sends); they guard the fix from over-reaching, so
// they are supposed to be green on both sides.
//
// An earlier revision listed only the exports the NEW route uses, which made
// every case die at an import error before reaching its assertion — technically
// "fails against main", and proof of nothing. Keep the factories partial.
//
// The three defects:
//
//   D1  the sign-off was `reg.race_events.locations.name` unconditionally, so a
//       registrant of a hosted event was texted "— <host> (host events)": an
//       ops-only bookkeeping label minted by ensureAnchorLocation. Two ACTIVE
//       upcoming events sit on such a row in prod.
//   D2  no consent check at all. A registrant who has opted out of
//       administrative SMS, or whose number is marked opted_out/invalid, was
//       texted anyway.
//   D3  a location with no sender fell through resolveSenderLocation →
//       getLocationSenderId → `TWILIO_FROM || 'CCFautos'`. CCF Autos is a
//       DIFFERENT BUSINESS in this estate.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/connection-registry', () => ({
  overlayConnections: vi.fn(async (_db, row) => row),
  overlayConnectionsMany: vi.fn(async (_db, rows) => rows),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const sendLocationSms = vi.fn(async () => ({ sid: 'SM1' }))
const resolveTenantSmsSender = vi.fn(async (_db, l) => ({
  location: l, senderId: l?.twilio_alpha_sender_id || null, source: l?.twilio_alpha_sender_id ? 'location' : 'none',
}))
// `resolveSenderLocation` is stubbed even though the CURRENT route never calls
// it: main does, and these tests are supposed to run against main and fail on
// the assertion. It mirrors main's own behaviour (hand the location back, let
// getLocationSenderId fall through) so D3 is demonstrated rather than dodged.
const resolveSenderLocation = vi.fn(async (_db, l) => l)
vi.mock('@/lib/twilio', async (importOriginal) => ({
  ...(await importOriginal()),
  sendLocationSms: (...a) => sendLocationSms(...a),
  resolveSenderLocation: (...a) => resolveSenderLocation(...a),
  resolveTenantSmsSender: (...a) => resolveTenantSmsSender(...a),
}))

const resolveEventCommsLocation = vi.fn(async () => null)
vi.mock('@/lib/event-comms-location', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolveEventCommsLocation: (...a) => resolveEventCommsLocation(...a) }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const REG_ID = 'r0000000-0000-0000-0000-000000000001'

// The real prod shape: a host's ops-only anchor location. Named exactly as
// ensureAnchorLocation names it, flagged, and (as in prod) carrying a sender.
const ANCHOR = {
  id: 'ANCHOR',
  name: 'Pride Training Club (host events)',
  is_host_anchor: true,
  twilio_alpha_sender_id: 'UN1T Dub',
  organization_id: 'ORG',
}
const STILLORGAN = {
  id: 'MASTER', name: 'UN1T Stillorgan', is_host_anchor: false,
  twilio_alpha_sender_id: 'UN1T Dub', organization_id: 'ORG',
}

function makeDb({ event = {}, contact = { id: 'c1', email_status: 'active', sms_status: 'active', contact_preferences: [] }, contactError = null } = {}) {
  return {
    from(table) {
      const b = {}
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b
      b.maybeSingle = async () => {
        if (table === 'race_registrations') {
          return {
            data: {
              id: REG_ID, status: 'confirmed',
              race_events: {
                id: 'ev1', name: 'Pride Training Club',
                location_id: 'ANCHOR', host_id: 'H', sending_location_id: null,
                venue_name: null,
                locations: { ...ANCHOR },
                ...event,
              },
            },
            error: null,
          }
        }
        if (table === 'contacts') {
          return contactError ? { data: null, error: contactError } : { data: contact, error: null }
        }
        return {
          data: {
            id: 'pay1', status: 'pending', contact_id: 'c1', contact_name: 'A Runner',
            contact_phone: '+353871234567', amount_cents: 2500, currency: 'EUR',
          },
          error: null,
        }
      }
      b.insert = async () => ({ error: null })
      return b
    },
  }
}

const props = { params: Promise.resolve({ id: REG_ID }) }
const sentBody = () => sendLocationSms.mock.calls[0][0].body

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', isMaster: true })
  createServerClient.mockImplementation(() => makeDb())
  sendLocationSms.mockImplementation(async () => ({ sid: 'SM1' }))
  resolveEventCommsLocation.mockResolvedValue(null)
  resolveTenantSmsSender.mockImplementation(async (_db, l) => ({
    location: l, senderId: l?.twilio_alpha_sender_id || null,
    source: l?.twilio_alpha_sender_id ? 'location' : 'none',
  }))
})

// ── D1 ───────────────────────────────────────────────────────────────────
describe('D1 — the sign-off a registrant actually reads', () => {
  it('NEVER signs off with the ops-only anchor label', async () => {
    // Host event, no venue name, comms location unresolved: main signed off
    // "— Pride Training Club (host events)".
    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(200)
    expect(sentBody()).not.toContain('(host events)')
    expect(sentBody()).not.toContain('Pride Training Club (host events)')
    // No usable public name anywhere → no sign-off at all. The alpha sender
    // carries the brand; an internal string would not.
    expect(sentBody()).toBe(
      "Hi A, here's your link to pay €25.00 and secure your spot for Pride Training Club: https://crm.test/event-pay/pay1",
    )
  })

  it('signs off with the RESOLVED comms location when there is no venue name', async () => {
    resolveEventCommsLocation.mockResolvedValue(STILLORGAN)

    await POST(new Request('http://x', { method: 'POST' }), props)

    expect(sentBody()).toContain('— UN1T Stillorgan')
    expect(sentBody()).not.toContain('(host events)')
  })

  it("prefers the event's venue name over any location name", async () => {
    createServerClient.mockImplementation(() => makeDb({ event: { venue_name: 'UN1T STILLORGAN' } }))
    resolveEventCommsLocation.mockResolvedValue(STILLORGAN)

    await POST(new Request('http://x', { method: 'POST' }), props)

    expect(sentBody()).toContain('— UN1T STILLORGAN')
  })

  it('a plain non-host event still signs off with its own location', async () => {
    createServerClient.mockImplementation(() => makeDb({
      event: { location_id: 'MASTER', host_id: null, locations: { ...STILLORGAN } },
    }))

    await POST(new Request('http://x', { method: 'POST' }), props)

    expect(sentBody()).toContain('— UN1T Stillorgan')
  })
})

// ── D2 ───────────────────────────────────────────────────────────────────
describe('D2 — consent and hard signals', () => {
  it('REFUSES to text a registrant who opted out of administrative SMS', async () => {
    createServerClient.mockImplementation(() => makeDb({
      contact: { id: 'c1', sms_status: 'active', contact_preferences: [{ sms_administrative: false }] },
    }))

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('opted_out_administrative_sms')
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('REFUSES a number marked opted_out / invalid', async () => {
    createServerClient.mockImplementation(() => makeDb({
      contact: { id: 'c1', sms_status: 'opted_out', contact_preferences: [] },
    }))

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(400)
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('STILL TEXTS someone who only opted out of MARKETING sms', async () => {
    // The nuance that matters: a payment link is transactional. Suppressing it
    // on the marketing flag would be a worse bug than the one being fixed.
    createServerClient.mockImplementation(() => makeDb({
      contact: {
        id: 'c1', sms_status: 'active',
        contact_preferences: [{ sms_marketing: false, sms_administrative: true }],
      },
    }))

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(200)
    expect(sendLocationSms).toHaveBeenCalledTimes(1)
  })

  it('LINK NOT LOST: an unreadable consent row still sends', async () => {
    // CLAUDE.md — removing a silent failure must not create a louder one. A DB
    // blip must not block an action an operator explicitly asked for.
    createServerClient.mockImplementation(() => makeDb({ contactError: { message: 'connection reset' } }))

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(200)
    expect(sendLocationSms).toHaveBeenCalledTimes(1)
  })
})

// ── D3 ───────────────────────────────────────────────────────────────────
describe('D3 — never send under another business’s sender', () => {
  it('refuses with an actionable error instead of texting from CCF Autos', async () => {
    resolveTenantSmsSender.mockResolvedValue({ location: { id: 'ANCHOR' }, senderId: null, source: 'none' })

    const res = await POST(new Request('http://x', { method: 'POST' }), props)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(sendLocationSms).not.toHaveBeenCalled()
    expect(body.error).toContain('No SMS sender is configured')
    // The operator is told what to do, and the "copy payment link" button on
    // the same screen still works — nothing is lost in silence.
    expect(body.error).toContain('copy the payment link')
  })

  it('sends normally when a tenant sender resolves', async () => {
    resolveEventCommsLocation.mockResolvedValue(STILLORGAN)

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(200)
    expect(sendLocationSms).toHaveBeenCalledWith(expect.objectContaining({
      location: expect.objectContaining({ twilio_alpha_sender_id: 'UN1T Dub' }),
      to: '+353871234567',
    }))
  })
})
