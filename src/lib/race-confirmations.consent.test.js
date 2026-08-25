// EVENT-CONSENT.1 — the consent gate ON THE PATH THAT CARRIES THE MONEY.
//
// D2 was that sendRaceConfirmations checked NO consent and NO suppression state
// at all. The fix is easy to get wrong in a way that is far worse than the
// defect, so this file pins the direction of every branch:
//
//   • a MARKETING opt-out must still receive the receipt   (47 of 193 completed
//     race payments in prod are such contacts — gating on the marketing family
//     would delete a quarter of all receipts and their check-in QRs)
//   • an unreadable consent row must still SEND, and log
//   • a MACHINE-SET administrative opt-out must still SEND, and log. In this
//     database `email_administrative = false` means "ClassPass PAYG" for 1626
//     of the 1627 contacts that carry it, and consent_log holds ZERO
//     human-written administrative opt-outs — it is mig 151's blanket trigger,
//     not anybody's request. See transactional-consent.js's header.
//   • a HARD SIGNAL (bounced/complained) suppresses — and says so LOUDLY,
//     because nothing ever retries this path.
//
// Why "nothing retries": markRacePaymentStatus returns `applied: null` once the
// payment is already 'completed', so no webhook redelivery re-invokes this. A
// wrongly-suppressed receipt is gone, along with the attendee's proof of entry.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
const sendLocationSms = vi.fn(async () => ({ sid: 'SM1' }))
const logError = vi.fn()

vi.mock('./postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
vi.mock('./log', () => ({ logError: (...a) => logError(...a) }))
vi.mock('./twilio', async (importOriginal) => ({
  ...(await importOriginal()),
  sendLocationSms: (...a) => sendLocationSms(...a),
  resolveTenantSmsSender: vi.fn(async (_db, l) => ({ location: l, senderId: 'UN1T', source: 'location' })),
}))
vi.mock('./event-comms-location', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEventCommsLocation: vi.fn(async () => ({ id: 'LOC', name: 'UN1T Stillorgan' })),
}))
vi.mock('@/lib/connection-registry', () => ({ overlayConnections: vi.fn(async (_db, row) => row) }))
vi.mock('./event-email', () => ({
  resolveEventEmail: vi.fn(async () => ({ subject: 'You are in', htmlBody: '<p>hi</p>' })),
  buildEventEmailShell: vi.fn(() => '<html></html>'),
}))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.example.com' }))
vi.mock('./event-checkin-tokens', () => ({ signCheckinToken: () => 'tok' }))

import { sendRaceConfirmations } from './race-confirmations'

const PAYMENT_ID = 'p0000000-0000-0000-0000-000000000001'
const CONTACT_ID = 'c0000000-0000-0000-0000-000000000001'

/**
 * @param {object} opts
 * @param {object|null} opts.contact       the `contacts` row the gate reads
 * @param {boolean} opts.contactReadFails  make that read error
 * @param {object|null} opts.consentLogRow latest consent_log row for the channel
 * @param {boolean} opts.consentLogFails   make the provenance read error
 * @param {boolean} opts.smsEnabled        turn the SMS leg on
 */
function makeWorld({
  contact = {
    id: CONTACT_ID,
    email_status: 'active',
    sms_status: 'active',
    contact_preferences: [{ email_administrative: true, sms_administrative: true }],
  },
  contactReadFails = false,
  consentLogRow = null,
  consentLogFails = false,
  smsEnabled = false,
} = {}) {
  const stamps = []
  const row = {
    id: PAYMENT_ID,
    contact_id: CONTACT_ID,
    contact_email: 'runner@example.com',
    contact_phone: '+353871234567',
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
      venue_name: 'The Venue', venue_address: null, accent_hex: null, hero_image_url: null,
      confirmation_email_subject: null, confirmation_email_intro: null,
      confirmation_email_template_id: null,
      confirmation_sms_enabled: smsEnabled,
      locations: { id: 'LOC', name: 'UN1T Stillorgan', twilio_alpha_sender_id: 'UN1T', organization_id: 'ORG' },
    },
    registration: { id: 'reg1', wave_id: null, wave: null, teams: { id: 't1', name: 'The Team', size: 1, team_members: [] } },
  }

  const db = {
    from(table) {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => (contactReadFails
                ? { data: null, error: { message: 'connection reset' } }
                : { data: contact, error: null }),
            }),
          }),
        }
      }
      if (table === 'consent_log') {
        const b = {}
        for (const m of ['select', 'eq', 'order']) b[m] = () => b
        b.limit = async () => (consentLogFails
          ? { data: null, error: { message: 'connection reset' } }
          : { data: consentLogRow ? [consentLogRow] : [], error: null })
        return b
      }
      if (table === 'activities') return { insert: async () => ({ error: null }) }
      if (table !== 'race_payments') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
        update(patch) {
          const state = { isNullOn: null }
          const b = {
            eq() { return b },
            is(col) { state.isNullOn = col; return b },
            select: async () => {
              stamps.push(state.isNullOn)
              row[state.isNullOn] = patch[state.isNullOn]
              return { data: [{ id: PAYMENT_ID }], error: null }
            },
          }
          return b
        },
      }
    },
  }
  return { db, stamps }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTransactionalEmail.mockImplementation(async () => ({ ok: true }))
})

describe('sendRaceConfirmations — the ADMINISTRATIVE family, not the marketing one', () => {
  it('STILL SENDS the receipt to someone who opted out of MARKETING email', async () => {
    // The worse-than-the-bug case. 47 of 193 completed payments in prod.
    const { db, stamps } = makeWorld({
      contact: {
        id: CONTACT_ID,
        email_status: 'active',
        sms_status: 'active',
        contact_preferences: [{ email_marketing: false, email_administrative: true }],
      },
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.sent).toContain('email')
    expect(stamps).toContain('confirmation_email_sent_at')
  })

  it('suppresses a HARD SIGNAL — and does NOT stamp, so the column still reads "never sent"', async () => {
    const { db, stamps } = makeWorld({
      contact: { id: CONTACT_ID, email_status: 'bounced', contact_preferences: [{ email_administrative: true }] },
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(result.sent).not.toContain('email')
    expect(result.skipped).toContain('email:email_status=bounced')
    expect(stamps).not.toContain('confirmation_email_sent_at')
  })

  it('LOGS LOUDLY when it suppresses — nothing retries this path, so silence is the real defect', async () => {
    const { db } = makeWorld({
      contact: { id: CONTACT_ID, email_status: 'complained', contact_preferences: [{ email_administrative: true }] },
    })

    await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    const suppressed = logError.mock.calls.find(([, msg]) => /SUPPRESSED/i.test(msg))
    expect(suppressed).toBeTruthy()
    expect(suppressed[2]).toMatchObject({ paymentId: PAYMENT_ID, reason: 'email_status=complained' })
  })
})

describe('sendRaceConfirmations — a consent read that FAILS must not cost the receipt', () => {
  it('RECEIPT NOT LOST: an unreadable consent row still sends, and logs', async () => {
    const { db } = makeWorld({ contactReadFails: true })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.sent).toContain('email')
    expect(logError.mock.calls.some(([, msg]) => /consent lookup failed/i.test(msg))).toBe(true)
  })
})

describe('sendRaceConfirmations — a MACHINE-SET administrative opt-out is not a customer request', () => {
  it('RECEIPT NOT LOST: mig 151 ClassPass blanket does not suppress a paid receipt', async () => {
    // The landmine: 1626 of the 1627 contacts with email_administrative=false
    // are ClassPass PAYG members flagged by a trigger. consent_log holds zero
    // human-written administrative opt-outs anywhere in this database.
    const { db, stamps } = makeWorld({
      contact: { id: CONTACT_ID, email_status: 'active', contact_preferences: [{ email_administrative: false }] },
      consentLogRow: { source: 'auto_classpass_backfill', action: 'opt_out', created_at: '2026-01-01T00:00:00Z' },
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.sent).toContain('email')
    expect(stamps).toContain('confirmation_email_sent_at')
    expect(logError.mock.calls.some(([, msg]) => /DISREGARDED/i.test(msg))).toBe(true)
  })

  it('HONOURS a genuine person-set opt-out — latest consent_log row wins', async () => {
    // A ClassPass member who LATER opted out for real through the preference
    // centre is a different person from one the trigger merely swept up.
    const { db, stamps } = makeWorld({
      contact: { id: CONTACT_ID, email_status: 'active', contact_preferences: [{ email_administrative: false }] },
      consentLogRow: { source: 'preference_centre', action: 'opt_out', created_at: '2026-08-01T00:00:00Z' },
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(result.skipped).toContain('email:opted_out_administrative_email')
    expect(stamps).not.toContain('confirmation_email_sent_at')
    expect(logError.mock.calls.some(([, msg]) => /SUPPRESSED/i.test(msg))).toBe(true)
  })

  it('an UNREADABLE provenance lookup sends too — it cannot be the thing that loses the message', async () => {
    const { db } = makeWorld({
      contact: { id: CONTACT_ID, email_status: 'active', contact_preferences: [{ email_administrative: false }] },
      consentLogFails: true,
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.sent).toContain('email')
  })
})

describe('sendRaceConfirmations — the SMS leg', () => {
  it('skips the text on an sms opt-out while the EMAIL receipt still goes out', async () => {
    // The legs are independent, and it is the email that carries the QR.
    const { db } = makeWorld({
      smsEnabled: true,
      contact: {
        id: CONTACT_ID,
        email_status: 'active',
        sms_status: 'opted_out',
        contact_preferences: [{ email_administrative: true, sms_administrative: true }],
      },
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendLocationSms).not.toHaveBeenCalled()
    expect(result.skipped).toContain('sms:sms_status=opted_out')
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.sent).toContain('email')
  })

  it('skips rather than sending under another brand when NO tenant sender resolves', async () => {
    const twilio = await import('./twilio')
    twilio.resolveTenantSmsSender.mockImplementationOnce(async (_db, l) => ({ location: l, senderId: null, source: 'none' }))

    const { db } = makeWorld({ smsEnabled: true })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendLocationSms).not.toHaveBeenCalled()
    expect(result.skipped).toContain('sms:no_tenant_sms_sender')
    // The email leg is untouched — the attendee keeps their proof of entry.
    expect(result.sent).toContain('email')
  })

  it('distinguishes an UNREADABLE sender lookup from an unconfigured one', async () => {
    // "Set one in Location Settings" is false advice when the read simply
    // failed. Same refusal, different reason, different log.
    const twilio = await import('./twilio')
    twilio.resolveTenantSmsSender.mockImplementationOnce(async (_db, l) => ({ location: l, senderId: null, source: 'unreadable' }))

    const { db } = makeWorld({ smsEnabled: true })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.skipped).toContain('sms:sms_sender_unreadable')
    expect(logError.mock.calls.some(([, msg]) => /lookup FAILED/i.test(msg))).toBe(true)
  })
})
