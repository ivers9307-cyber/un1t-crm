// sendRaceConfirmations — the send-once guard.
//
// BAREWRITE.1 found both stamps written with a bare `await` AFTER the message
// went out, so a silently failed stamp let the next payment-webhook retry send
// the attendee a DUPLICATE receipt. Detecting the loss was not a fix: nothing
// retried the stamp, and all four callers answer 200 regardless, so the
// duplicate still went out.
//
// The stamp is now a CLAIM taken BEFORE the send (the shape the WhatsApp blast
// sender already uses for its recipient rows), with a CAS on `IS NULL` so a
// concurrent delivery loses cleanly, and a release when nothing was sent. The
// failure direction flips: a lost claim costs a receipt, never a duplicate.
//
// Also pinned here: resolveEventCommsLocation's throw is caught rather than
// escaping four call sites that all answer 200 — an unreadable sending
// location must be a recorded failure, not a silently missing receipt.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
const resolveEventCommsLocation = vi.fn(async () => ({ id: 'LOC', name: 'Stillorgan' }))

vi.mock('./postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
vi.mock('./twilio', () => ({
  sendLocationSms: vi.fn(async () => ({ sid: 'SM1' })),
  resolveSenderLocation: vi.fn(async (_db, l) => l),
  TwilioError: class TwilioError extends Error {},
}))
vi.mock('./event-comms-location', () => ({ resolveEventCommsLocation: (...a) => resolveEventCommsLocation(...a) }))
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
function makeWorld({ emailStampFails = false, releaseFails = false, alreadySent = null } = {}) {
  const calls = []
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
      if (table !== 'race_payments') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
        update(patch) {
          const state = { patch, isNullOn: null }
          const b = {
            eq() { return b },
            is(col) { state.isNullOn = col; return b },
            select: async () => {
              // The CLAIM: an UPDATE … WHERE col IS NULL … RETURNING id.
              calls.push({ op: 'claim', column: state.isNullOn })
              if (emailStampFails) return { data: null, error: { message: 'connection reset' } }
              if (row[state.isNullOn] != null) return { data: [], error: null }
              row[state.isNullOn] = patch[state.isNullOn]
              return { data: [{ id: PAYMENT_ID }], error: null }
            },
            // The RELEASE: a plain UPDATE with no `.select()`.
            then(resolve, reject) {
              calls.push({ op: 'release', patch })
              if (releaseFails) return Promise.resolve({ error: { message: 'still down' } }).then(resolve, reject)
              for (const k of Object.keys(patch)) row[k] = patch[k]
              return Promise.resolve({ error: null }).then(resolve, reject)
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

describe('sendRaceConfirmations — send-once claim', () => {
  it('claims the stamp BEFORE the email goes out', async () => {
    const { db, row, calls } = makeWorld()
    let stampAtSendTime
    sendTransactionalEmail.mockImplementation(async () => {
      stampAtSendTime = row.confirmation_email_sent_at
      return { ok: true }
    })

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.sent).toContain('email')
    // The whole point: the guard was already in place when the message left.
    expect(stampAtSendTime).toBeTruthy()
    expect(calls[0]).toMatchObject({ op: 'claim', column: 'confirmation_email_sent_at' })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
  })

  it('does NOT send when the claim cannot be written', async () => {
    const { db, row } = makeWorld({ emailStampFails: true })
    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(row.confirmation_email_sent_at).toBeNull()
    expect(result.sent).not.toContain('email')
    expect(result.failed.some(f => f.startsWith('email:claim_failed'))).toBe(true)
  })

  it('loses the CAS to a concurrent delivery instead of sending twice', async () => {
    // The row was read with a null stamp, but another invocation claimed it in
    // between — exactly the race a read-then-check could never see.
    const { db, row } = makeWorld()
    row.confirmation_email_sent_at = '2026-08-19T10:00:00.000Z'

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(result.skipped).toContain('email:already_sent')
  })

  it('releases the claim when the send throws, so the receipt is not suppressed forever', async () => {
    const { db, row } = makeWorld()
    sendTransactionalEmail.mockRejectedValue(new Error('postmark 500'))

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(row.confirmation_email_sent_at).toBeNull()
    expect(result.failed.some(f => f.includes('postmark 500'))).toBe(true)
    expect(result.failed).not.toContain('email:claim_stuck')
  })

  it('says so loudly when the send failed AND the claim could not be released', async () => {
    const { db, row } = makeWorld({ releaseFails: true })
    sendTransactionalEmail.mockRejectedValue(new Error('postmark 500'))

    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    // The stamp stands with nothing sent — an operator has to clear it.
    expect(row.confirmation_email_sent_at).toBeTruthy()
    expect(result.failed).toContain('email:claim_stuck')
  })

  it('records an unresolvable comms location instead of letting the throw escape', async () => {
    const { db, row } = makeWorld()
    resolveEventCommsLocation.mockRejectedValue(new Error('sending location read failed'))

    // It must not throw out of the function — four callers catch nothing here.
    const result = await sendRaceConfirmations({ db, paymentId: PAYMENT_ID })

    expect(result.failed.some(f => f.startsWith('comms_location:'))).toBe(true)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    // Nothing claimed, so a later invocation still delivers cleanly.
    expect(row.confirmation_email_sent_at).toBeNull()
  })
})
