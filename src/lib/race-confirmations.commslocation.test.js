// sendRaceConfirmations × resolveEventCommsLocation — the seam, unmocked.
//
// BAREWRITE.1 made the sender lookup throw so a discarded read error could not
// route a message from the wrong brand's sender. Right goal, over-charged: the
// final read threw for EVERY event, and for a PLAIN one (host_id null, no
// sending_location_id override) the target of that read is the event's own
// location_id — the exact value this function already falls back to. So a
// transient DB blip stopped buying anything and started costing a PAYING
// attendee their receipt, silently, inside an HTTP 200 the payment provider
// never retries.
//
// These tests deliberately do NOT mock ./event-comms-location. Mocking the
// resolver is what let the two halves drift: the resolver's own suite proved it
// threw, race-confirmations' suite proved the throw was caught, and nobody
// asked what the customer got. Both properties are asserted here end to end:
//   1. RECEIPT NOT LOST — plain event + unreadable location row → the email
//      still goes out, from the event's own location.
//   2. WRONG BRAND IMPOSSIBLE — host event / explicit override + unreadable
//      location row → nothing is sent and nothing is claimed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
const resolveMasterLocationIdStrict = vi.fn(async () => 'MASTER')

vi.mock('./postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
vi.mock('./twilio', () => ({
  sendLocationSms: vi.fn(async () => ({ sid: 'SM1' })),
  resolveSenderLocation: vi.fn(async (_db, l) => l),
  TwilioError: class TwilioError extends Error {},
}))
vi.mock('./host-events', () => ({ resolveMasterLocationIdStrict: (...a) => resolveMasterLocationIdStrict(...a) }))
vi.mock('@/lib/connection-registry', () => ({ overlayConnections: vi.fn(async (_db, row) => row) }))
vi.mock('./connection-registry', () => ({ overlayConnections: vi.fn(async (_db, row) => row) }))
vi.mock('./event-email', () => ({
  resolveEventEmail: vi.fn(async () => ({ subject: 'You are in', htmlBody: '<p>hi</p>' })),
  buildEventEmailShell: vi.fn(() => '<html></html>'),
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.example.com' }))
vi.mock('./event-checkin-tokens', () => ({ signCheckinToken: () => 'tok' }))

import { sendRaceConfirmations } from './race-confirmations'

const PAYMENT_ID = 'p0000000-0000-0000-0000-000000000002'

/**
 * A world where race_payments is real state and EVERY `locations` read fails —
 * the transient blip. `race` overrides shape the event (plain / host / override).
 */
function makeWorld(race = {}) {
  const row = {
    id: PAYMENT_ID,
    contact_email: 'runner@example.com',
    contact_phone: null,
    contact_name: 'A Runner',
    amount_cents: 2500,
    currency: 'EUR',
    member_count: 1,
    non_member_count: 0,
    member_fee_cents: null,
    non_member_fee_cents: null,
    status: 'completed',
    confirmation_email_sent_at: null,
    confirmation_sms_sent_at: null,
    race_event_id: 'r1',
    race_registration_id: 'reg1',
    race: {
      id: 'r1', name: 'Summer Race', slug: 'summer', race_date: '2026-09-01',
      location_id: 'LOC', host_id: null, sending_location_id: null,
      venue_name: null, venue_address: null, accent_hex: null, hero_image_url: null,
      confirmation_email_subject: null, confirmation_email_intro: null,
      confirmation_email_template_id: null,
      confirmation_sms_enabled: false,
      locations: { id: 'LOC', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T', organization_id: 'ORG' },
      ...race,
    },
    registration: { id: 'reg1', wave_id: null, wave: null, teams: null },
  }

  const db = {
    from(table) {
      if (table === 'locations') {
        // The blip: every location row read fails, both hops.
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }),
        }
        return b
      }
      if (table !== 'race_payments') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
        update(patch) {
          const state = { isNullOn: null }
          const b = {
            eq() { return b },
            is(col) { state.isNullOn = col; return b },
            select: async () => {
              if (row[state.isNullOn] != null) return { data: [], error: null }
              row[state.isNullOn] = patch[state.isNullOn]
              return { data: [{ id: PAYMENT_ID }], error: null }
            },
            then(resolve, reject) {
              for (const k of Object.keys(patch)) row[k] = patch[k]
              return Promise.resolve({ error: null }).then(resolve, reject)
            },
          }
          return b
        },
      }
    },
  }
  return { db, row }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTransactionalEmail.mockImplementation(async () => ({ ok: true }))
  resolveMasterLocationIdStrict.mockImplementation(async () => 'MASTER')
})

describe('a transient location read failure', () => {
  it('RECEIPT NOT LOST — a plain UN1T event still sends, from its own location', async () => {
    const { db, row } = makeWorld() // host_id null, sending_location_id null

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    expect(result.failed).toEqual([])
    // The sender the attendee's receipt went out under is the SAME location the
    // failed read was looking up — which is why failing open here is free.
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'runner@example.com', locationId: 'LOC' }),
    )
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })

  it('WRONG BRAND IMPOSSIBLE — a HOST event sends nothing, and claims nothing', async () => {
    const { db, row } = makeWorld({ host_id: 'H', location_id: 'ANCHOR' })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(result.failed.some(f => f.startsWith('comms_location:'))).toBe(true)
    // Nothing claimed → a later invocation delivers both legs cleanly.
    expect(row.confirmation_email_sent_at).toBeNull()
  })

  it('WRONG BRAND IMPOSSIBLE — an explicit sending_location_id override sends nothing either', async () => {
    const { db, row } = makeWorld({ sending_location_id: 'OTHER' })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(result.failed.some(f => f.startsWith('comms_location:'))).toBe(true)
    expect(row.confirmation_email_sent_at).toBeNull()
  })
})
