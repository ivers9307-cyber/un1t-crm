// sendRaceConfirmations — the send-once guard, and which way it fails.
//
// Three shapes have been tried, and the trade-off is the whole story:
//
//   main         both stamps written with a BARE `await` AFTER the send. The
//                stamp error was invisible. Real defect, but the ORDER was
//                right: a message never went missing.
//   BAREWRITE.2  CLAIM the stamp before sending, making the write a mutex.
//                Removed a duplicate risk and created a PERMANENT LOSS — a
//                process kill between the claim and the send (Vercel timeout,
//                OOM, deploy mid-request) leaves the column stamped with
//                nothing sent, and nothing retries: `markRacePaymentStatus`
//                returns `applied: null` once the payment is already
//                'completed', so a provider redelivery never re-invokes us.
//                It also produced a case where two overlapping deliveries sent
//                NOTHING between them — the loser skipped as `already_claimed`
//                while the winner's send failed and released the claim.
//   BAREWRITE.4  back to send-then-stamp, with the stamp error READ and logged,
//                and the CAS kept so a concurrent stamp is detected.
//
// The judgement: a duplicate receipt is an annoyance the customer can see and
// ignore; a missing one means they cannot check in on race day, because the
// per-person QR codes are in it. Losing a customer-facing message is worse than
// sending it twice, so this path fails toward the duplicate — and says so.
//
// These tests pin the ORDER and both failure directions.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
const resolveEventCommsLocation = vi.fn(async () => ({ id: 'LOC', name: 'Stillorgan' }))

vi.mock('./postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))

// PARTIAL mocks, deliberately. A whole-module factory that lists only the
// exports this file happens to use turns the ADDITION of an export elsewhere
// into a red suite here — and these seven tests are the send-then-stamp
// regression guards, so disarming them is exactly the accident to avoid.
// `importOriginal` keeps every other export real, so a new one cannot break us.
vi.mock('./twilio', async (importOriginal) => ({
  ...(await importOriginal()),
  sendLocationSms: vi.fn(async () => ({ sid: 'SM1' })),
  resolveSenderLocation: vi.fn(async (_db, l) => l),
  resolveTenantSmsSender: vi.fn(async (_db, l) => ({ location: l, senderId: 'UN1T', source: 'location' })),
}))
vi.mock('./event-comms-location', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEventCommsLocation: (...a) => resolveEventCommsLocation(...a),
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

// A world where race_payments is real state, so the CAS behaves like the CAS.
// `onStamp` runs at the moment the stamp UPDATE executes — that is where a
// concurrent invocation is simulated.
function makeWorld({ stampFails = false, alreadySent = null, onStamp = null } = {}) {
  const calls = []
  const row = {
    id: PAYMENT_ID,
    // Present ON PURPOSE. With no contact_id the consent gate short-circuits
    // before it queries anything, so these tests would pass without the fake db
    // ever modelling `contacts` — coverage by accident, and it would evaporate
    // the day a fixture grew a contact. Give it one, and model the table.
    contact_id: 'c0000000-0000-0000-0000-000000000001',
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
    confirmation_email_sent_at: alreadySent,
    confirmation_sms_sent_at: null,
    race_event_id: 'r1',
    race_registration_id: 'reg1',
    race: {
      id: 'r1', name: 'Summer Race', slug: 'summer', race_date: '2026-09-01',
      location_id: 'LOC', host_id: null, sending_location_id: null,
      venue_name: null, venue_address: null, accent_hex: null, hero_image_url: null,
      confirmation_email_subject: null, confirmation_email_intro: null,
      confirmation_email_template_id: null,
      // SMS off, so these tests exercise the email leg only.
      confirmation_sms_enabled: false,
      locations: { id: 'LOC', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T', organization_id: 'ORG' },
    },
    registration: { id: 'reg1', wave_id: null, wave: null, teams: null },
  }

  const db = {
    from(table) {
      // A contact with nothing suppressing: these tests are about send ORDER,
      // not consent. race-confirmations.consent.test.js owns the gate itself.
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'c0000000-0000-0000-0000-000000000001',
                  email_status: 'active',
                  sms_status: 'active',
                  contact_preferences: { email_administrative: true, sms_administrative: true },
                },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table !== 'race_payments') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
        update(patch) {
          const state = { patch, isNullOn: null }
          const b = {
            eq() { return b },
            is(col) { state.isNullOn = col; return b },
            // UPDATE … WHERE col IS NULL … RETURNING id — the stamp.
            select: async () => {
              calls.push({ op: 'stamp', column: state.isNullOn })
              if (onStamp) onStamp(row)
              if (stampFails) return { data: null, error: { message: 'connection reset' } }
              if (row[state.isNullOn] != null) return { data: [], error: null }
              row[state.isNullOn] = patch[state.isNullOn]
              return { data: [{ id: PAYMENT_ID }], error: null }
            },
          }
          return b
        },
      }
    },
  }
  return { db, row, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTransactionalEmail.mockImplementation(async () => ({ ok: true }))
  resolveEventCommsLocation.mockImplementation(async () => ({ id: 'LOC', name: 'Stillorgan' }))
})

describe('sendRaceConfirmations — send-once ordering', () => {
  it('sends FIRST and stamps after, so a crash before the stamp cannot suppress the receipt', async () => {
    const { db, row, calls } = makeWorld()
    let stampAtSendTime
    sendTransactionalEmail.mockImplementation(async () => {
      stampAtSendTime = row.confirmation_email_sent_at
      return { ok: true }
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    // THE REGRESSION. Under claim-first this was already truthy at send time,
    // which is precisely what made a process kill here permanent and silent.
    expect(stampAtSendTime).toBeNull()
    expect(calls.filter(c => c.op === 'stamp')).toHaveLength(1)
    expect(row.confirmation_email_sent_at).toBeTruthy()
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
  })

  it('RECEIPT NOT LOST: a stamp write that FAILS never costs the message', async () => {
    const { db, row } = makeWorld({ stampFails: true })
    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    // Claim-first refused to send at all here. The message is what matters.
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.sent).toContain('email')
    // …and the lost stamp is loud, not silent: it is a real defect (a later
    // re-run would send again), just not one worth withholding a receipt over.
    expect(result.failed.some(f => f.startsWith('email:stamp_failed'))).toBe(true)
    expect(row.confirmation_email_sent_at).toBeNull()
  })

  it('does not re-send when the stamp is already set (the ordinary idempotent case)', async () => {
    const { db } = makeWorld({ alreadySent: '2026-08-19T10:00:00.000Z' })
    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(result.skipped).toContain('email:already_sent')
  })

  it('reports a genuine duplicate when a concurrent invocation stamped mid-send', async () => {
    // The accepted cost of this ordering: both invocations read a null stamp,
    // both sent. The CAS catches it after the fact so it is recorded rather
    // than hidden — the customer got two receipts, which is the safe direction.
    const { db, row } = makeWorld({
      onStamp: (r) => { r.confirmation_email_sent_at = '2026-08-19T10:00:00.000Z' },
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(result.failed).toContain('email:duplicate_send')
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })

  it('does NOT stamp when the send itself failed, so a later run still delivers', async () => {
    const { db, row, calls } = makeWorld()
    sendTransactionalEmail.mockRejectedValue(new Error('postmark 500'))

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(row.confirmation_email_sent_at).toBeNull()
    expect(calls.filter(c => c.op === 'stamp')).toHaveLength(0)
    expect(result.failed.some(f => f.includes('postmark 500'))).toBe(true)
  })

  it('TWO OVERLAPPING DELIVERIES: at least one receipt always goes out', async () => {
    // Under claim-first, this exact sequence sent NOTHING: the loser skipped as
    // `already_claimed`, and the winner's failed send released the claim, so
    // both invocations returned having delivered nothing at all.
    const { db, row } = makeWorld()
    let attempt = 0
    sendTransactionalEmail.mockImplementation(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('postmark 500')
      return { ok: true }
    })

    const [a, b] = await Promise.all([
      sendRaceConfirmations({ db, paymentId: PAYMENT_ID }),
      sendRaceConfirmations({ db, paymentId: PAYMENT_ID }),
    ])

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    expect([...a.sent, ...b.sent]).toContain('email')
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })

  it('a resolver that throws is caught and the receipt still goes out', async () => {
    const { db, row } = makeWorld()
    resolveEventCommsLocation.mockRejectedValue(new Error('sending location read failed'))

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    // Fell back to the event's own location — same org, same sender.
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'LOC' }),
    )
    expect(row.confirmation_email_sent_at).toBeTruthy()
  })
})
