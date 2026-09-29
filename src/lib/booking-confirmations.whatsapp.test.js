// EVENTCONFIRM-WA.1 — the booking confirmation's WhatsApp leg (mig 666).
//
// SMS left with Twilio (TWILIO-RETIRE.1) and stranded the one event type that
// confirmed by SMS only. The replacement is an operator-picked APPROVED
// template per event type, sent through the same helper the /start funnel
// uses. These pin: the template is read at the EVENT TYPE's location, its body
// variables fill positionally ({{1}} first name, {{2}} day + time, {{3}} event
// name), consent is the ADMINISTRATIVE family, and a misconfiguration is a
// recorded skip while a failed send is a failure.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const maybeSendBookingWhatsappConfirm = vi.fn(async () => ({ sent: true, messageId: 'wamid.1' }))
const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))

vi.mock('./postmark', () => ({
  sendTransactionalEmail: (...a) => sendTransactionalEmail(...a),
  applyMergeTags: (s) => s,
}))
vi.mock('./wallet-enforcement', () => ({ logTransactionalWalletState: vi.fn() }))
vi.mock('./log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({
  maybeSendBookingWhatsappConfirm: (...a) => maybeSendBookingWhatsappConfirm(...a),
}))

import { sendBookingConfirmation } from './booking-confirmations'

const TPL_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function booking(overrides = {}) {
  return {
    id: 'b1', contact_id: 'c1',
    customer_name: 'Sam Member', customer_email: 'sam@example.com', customer_phone: '0871234567',
    booking_date: '2026-10-02', start_time: '17:00:00',
    event_types: {
      id: 'et1', name: 'Free UN1T Consultation', location_id: 'LOC',
      confirmation_enabled: true, confirmation_channels: ['whatsapp'],
      confirmation_email_template_id: null, confirmation_email_subject: null,
      confirmation_whatsapp_template_id: TPL_ID,
    },
    contacts: {
      id: 'c1', first_name: 'Sam', name: 'Sam Member', email: 'sam@example.com',
      phone: '0871234567', wa_phone: null, email_status: 'active', wa_status: 'active',
      contact_preferences: [{ email_administrative: true, whatsapp_administrative: true }],
    },
    ...overrides,
  }
}

function makeDb({ row = booking(), template = { name: 'booking_consult_confirmed', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, see you {{2}}.' }] } } = {}) {
  const templateFilters = []
  const db = {
    from(table) {
      if (table === 'bookings') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }) }
      }
      if (table === 'whatsapp_templates') {
        const b = {
          select: () => b,
          eq: (col, val) => { templateFilters.push([col, val]); return b },
          maybeSingle: async () => ({ data: template, error: null }),
        }
        return b
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, templateFilters }
}

beforeEach(() => vi.clearAllMocks())

describe('sendBookingConfirmation — WhatsApp channel', () => {
  it('sends the event type\'s template at its OWN location, variables in order', async () => {
    const { db, templateFilters } = makeDb()
    const r = await sendBookingConfirmation(db, 'b1')
    expect(r.sent).toEqual(['whatsapp'])
    expect(templateFilters).toContainEqual(['id', TPL_ID])
    expect(templateFilters).toContainEqual(['location_id', 'LOC'])
    const call = maybeSendBookingWhatsappConfirm.mock.calls[0][0]
    expect(call).toMatchObject({ locationId: 'LOC', templateName: 'booking_consult_confirmed' })
    // Two variables in the body → first name + Dublin wall-clock day/time only.
    expect(call.bodyParams).toHaveLength(2)
    expect(call.bodyParams[0]).toBe('Sam')
    expect(call.bodyParams[1]).toMatch(/17:00$/)
    expect(call.contact).toMatchObject({ id: 'c1', phone: '0871234567' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('a three-variable template also gets the event name', async () => {
    const { db } = makeDb({ template: { name: 't3', status: 'APPROVED', components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}}' }] } })
    await sendBookingConfirmation(db, 'b1')
    expect(maybeSendBookingWhatsappConfirm.mock.calls[0][0].bodyParams[2]).toBe('Free UN1T Consultation')
  })

  it('prefers the contact\'s wa_phone over the ordinary phone', async () => {
    const row = booking()
    row.contacts = { ...row.contacts, wa_phone: '+353861111111' }
    const { db } = makeDb({ row })
    await sendBookingConfirmation(db, 'b1')
    expect(maybeSendBookingWhatsappConfirm.mock.calls[0][0].contact.phone).toBe('+353861111111')
  })

  it('no template picked → recorded skip, nothing sent', async () => {
    const row = booking()
    row.event_types = { ...row.event_types, confirmation_whatsapp_template_id: null }
    const { db } = makeDb({ row })
    const r = await sendBookingConfirmation(db, 'b1')
    expect(r.skipped).toEqual(['whatsapp:no_template_configured'])
    expect(maybeSendBookingWhatsappConfirm).not.toHaveBeenCalled()
  })

  it('a template not at this location (or deleted) → recorded skip', async () => {
    const { db } = makeDb({ template: null })
    const r = await sendBookingConfirmation(db, 'b1')
    expect(r.skipped).toEqual(['whatsapp:template_not_found'])
    expect(maybeSendBookingWhatsappConfirm).not.toHaveBeenCalled()
  })

  it('honours a WhatsApp STOP and an administrative opt-out, not a marketing one', async () => {
    const stopped = booking()
    stopped.contacts = { ...stopped.contacts, wa_status: 'opted_out' }
    expect((await sendBookingConfirmation(makeDb({ row: stopped }).db, 'b1')).skipped).toEqual(['whatsapp:wa_status=opted_out'])

    const adminOut = booking()
    adminOut.contacts = { ...adminOut.contacts, contact_preferences: [{ whatsapp_administrative: false }] }
    expect((await sendBookingConfirmation(makeDb({ row: adminOut }).db, 'b1')).skipped).toEqual(['whatsapp:opted_out_administrative_whatsapp'])

    const marketingOut = booking()
    marketingOut.contacts = { ...marketingOut.contacts, contact_preferences: [{ whatsapp_administrative: true, whatsapp_marketing: false }] }
    expect((await sendBookingConfirmation(makeDb({ row: marketingOut }).db, 'b1')).sent).toEqual(['whatsapp'])
    expect(maybeSendBookingWhatsappConfirm).toHaveBeenCalledTimes(1)
  })

  it('a failed SEND is a failure; the helper\'s other reasons are skips', async () => {
    maybeSendBookingWhatsappConfirm.mockResolvedValueOnce({ sent: false, reason: 'send_failed' })
    expect((await sendBookingConfirmation(makeDb().db, 'b1')).failed).toEqual(['whatsapp:WhatsApp send failed'])

    maybeSendBookingWhatsappConfirm.mockResolvedValueOnce({ sent: false, reason: 'template_PAUSED' })
    expect((await sendBookingConfirmation(makeDb().db, 'b1')).skipped).toEqual(['whatsapp:template_PAUSED'])
  })

  it('a legacy sms channel beside whatsapp is skipped, whatsapp still goes', async () => {
    const row = booking()
    row.event_types = { ...row.event_types, confirmation_channels: ['sms', 'whatsapp'] }
    const r = await sendBookingConfirmation(makeDb({ row }).db, 'b1')
    expect(r.sent).toEqual(['whatsapp'])
    expect(r.skipped).toEqual(['sms:unsupported_channel:sms'])
  })
})
