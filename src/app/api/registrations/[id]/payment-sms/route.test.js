// POST /api/registrations/[id]/payment-sms — the operator's "text them the
// payment link" button.
//
// BAREWRITE.1 made resolveEventCommsLocation throw on an unreadable location
// row and this route answer 503, telling the operator to try again. That refuses
// an action a human explicitly asked for, over a read whose only job is to pick
// between the event's own location and its org master — the same organisation,
// therefore the same email identity, and — for every event prod holds today,
// though not for every location pair in it — the same Twilio alpha sender (the
// measurement and its expiry condition are in event-comms-location.js).
// `resolveSenderLocation` is already the inner safety net for a sender-less
// anchor.
//
// BAREWRITE.4 fails open: log it, send from the event's own location.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/connection-registry', () => ({ overlayConnections: vi.fn(async (_db, row) => row) }))

const sendLocationSms = vi.fn(async () => ({ sid: 'SM1' }))
const resolveSenderLocation = vi.fn(async (_db, l) => l)
vi.mock('@/lib/twilio', () => ({
  sendLocationSms: (...a) => sendLocationSms(...a),
  resolveSenderLocation: (...a) => resolveSenderLocation(...a),
  TwilioError: class TwilioError extends Error {},
}))

const resolveEventCommsLocation = vi.fn(async () => ({ id: 'MASTER', name: 'Stillorgan' }))
vi.mock('@/lib/event-comms-location', () => ({
  resolveEventCommsLocation: (...a) => resolveEventCommsLocation(...a),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const REG_ID = 'r0000000-0000-0000-0000-000000000001'
const ANCHOR = { id: 'ANCHOR', name: 'Pride (host events)', twilio_alpha_sender_id: 'UN1T Dub', organization_id: 'ORG' }

function makeDb() {
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
                id: 'ev1', name: 'Hyrox Sim',
                location_id: 'ANCHOR', host_id: 'H', sending_location_id: null,
                locations: { ...ANCHOR },
              },
            },
            error: null,
          }
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

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', isMaster: true })
  createServerClient.mockImplementation(() => makeDb())
  sendLocationSms.mockImplementation(async () => ({ sid: 'SM1' }))
  resolveSenderLocation.mockImplementation(async (_db, l) => l)
})

describe('payment-sms — an unresolvable comms location', () => {
  it('LINK NOT LOST: a resolver THROW still sends, from the event location', async () => {
    resolveEventCommsLocation.mockRejectedValue(new Error('sending location read failed'))

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    // THE REGRESSION: this was a 503 with nothing sent.
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(sendLocationSms).toHaveBeenCalledTimes(1)
    // resolveSenderLocation is handed the event's OWN location — the fallback
    // the whole route already had, and the inner safety net for a sender-less
    // anchor still applies on top of it.
    expect(resolveSenderLocation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'ANCHOR' }))
  })

  it('LINK NOT LOST: a resolver returning null (the fail-open path) sends too', async () => {
    resolveEventCommsLocation.mockResolvedValue(null)

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(200)
    expect(sendLocationSms).toHaveBeenCalledTimes(1)
  })

  it('still prefers the resolved comms location when the read succeeds', async () => {
    resolveEventCommsLocation.mockResolvedValue({ id: 'MASTER', name: 'Stillorgan' })

    const res = await POST(new Request('http://x', { method: 'POST' }), props)

    expect(res.status).toBe(200)
    expect(resolveSenderLocation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'MASTER' }))
  })
})
