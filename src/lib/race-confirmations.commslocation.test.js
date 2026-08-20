// sendRaceConfirmations × resolveEventCommsLocation — the seam, unmocked.
//
// BAREWRITE.1 made the sender lookup throw so a discarded read error could not
// route a message from the wrong brand's sender. Right goal, wrong price: the
// throw escaped to here, `sendRaceConfirmations` returned before sending, and
// every caller answers HTTP 200 — so a transient DB blip silently cost a PAYING
// attendee their receipt AND their per-person check-in QR, with nothing to
// retry it (`markRacePaymentStatus` returns `applied: null` once the payment is
// already 'completed', so a provider redelivery never re-invokes us).
// BAREWRITE.3 narrowed the throw to brand-crossing events; BAREWRITE.4 removed
// it, because the brand cannot differ — email identity resolves per
// ORGANISATION, and no location pair in prod differs on the SMS alpha sender
// (the measurement is in event-comms-location.js).
//
// These tests deliberately do NOT mock ./event-comms-location. Mocking the
// resolver is what let the two halves drift: the resolver's own suite proved it
// threw, race-confirmations' suite proved the throw was caught, and nobody
// asked what the customer got. The property asserted end to end is now the
// single one that matters:
//
//   A LOCATION READ FAILURE NEVER COSTS THE RECEIPT — for a plain event, a
//   host event, or an explicit sending_location_id override alike.

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

  // The two shapes BAREWRITE.1/.3 silently deleted. Both are receipts for money
  // already taken; both now go out, from the event's own location — the same
  // organisation as the target, hence the same email identity and the same
  // alpha sender.
  it('RECEIPT NOT LOST — a HOST event still sends, from the event location', async () => {
    const { db, row } = makeWorld({ host_id: 'H', location_id: 'ANCHOR' })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    expect(result.failed).toEqual([])
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'runner@example.com', locationId: 'ANCHOR' }),
    )
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })

  it('RECEIPT NOT LOST — an explicit sending_location_id override still sends', async () => {
    const { db, row } = makeWorld({ sending_location_id: 'OTHER' })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    expect(result.failed).toEqual([])
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'LOC' }),
    )
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })

  it('RECEIPT NOT LOST — even a resolver that THROWS outright cannot cost the receipt', async () => {
    // Belt-and-braces: the resolver no longer throws, but a future hop that
    // forgets must not be able to delete a paid attendee's receipt. The
    // middle-hop helper is the one place a throw can still originate.
    resolveMasterLocationIdStrict.mockImplementation(async () => { throw new Error('organizations read failed') })
    const { db, row } = makeWorld({ host_id: 'H', location_id: 'ANCHOR' })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })
})
