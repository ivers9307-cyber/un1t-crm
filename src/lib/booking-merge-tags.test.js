// W1.S1a — booking confirmations and event reminders render the location
// merge tags the template editor offers: {{location_name}} (the sending
// location's own name) and {{company_name}} (its configured brand). Both
// rendered blank before. The REAL applyMergeTags runs; Postmark is stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { verifyBookingManageToken } from './booking-manage-tokens'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/postmark', async (importOriginal) => ({
  ...(await importOriginal()),
  sendTransactionalEmail: (...a) => sendTransactionalEmail(...a),
}))
vi.mock('@/lib/wallet-enforcement', () => ({ logTransactionalWalletState: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async (_db, id) => (id === 'LOC'
    ? { companyName: 'UN1T Stillorgan', shortName: 'UN1T', locationName: 'Stillorgan' }
    : { companyName: '', shortName: '', locationName: '' })),
}))

import { sendBookingConfirmation, bookingLocationMergeExtras } from './booking-confirmations'
import { sendEmailReminder } from './event-reminders'
import { getLocationBranding } from '@/lib/location-branding'

const TPL = { subject: 'Booked at {{company_name}}', html_content: '<p>See you at {{location_name}}, {{company_name}}.</p>' }

function booking() {
  return {
    id: 'b1', contact_id: 'c1',
    customer_name: 'Sam Member', customer_email: 'sam@example.com', customer_phone: null,
    booking_date: '2026-10-02', start_time: '17:00:00',
    event_types: {
      id: 'et1', name: 'Consultation', location_id: 'LOC',
      confirmation_enabled: true, confirmation_channels: ['email'],
      confirmation_email_template_id: 'tpl-1', confirmation_email_subject: null,
      confirmation_whatsapp_template_id: null,
    },
    contacts: {
      id: 'c1', first_name: 'Sam', name: 'Sam Member', email: 'sam@example.com',
      email_status: 'active', contact_preferences: [{ email_administrative: true }],
    },
  }
}

function makeDb() {
  return {
    from(table) {
      if (table === 'bookings') return { select: () => ({ eq: () => ({ single: async () => ({ data: booking(), error: null }) }) }) }
      if (table === 'email_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: TPL, error: null }) }) }) }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('bookingLocationMergeExtras', () => {
  it('resolves the location name and brand, blank when unresolved', async () => {
    expect(await bookingLocationMergeExtras({}, 'LOC')).toEqual({ location_name: 'Stillorgan', company_name: 'UN1T Stillorgan' })
    expect(await bookingLocationMergeExtras({}, 'OTHER')).toEqual({ location_name: '', company_name: '' })
  })
})

describe('booking confirmation email', () => {
  it('renders {{company_name}} and {{location_name}} for the event type location', async () => {
    const db = makeDb()
    const r = await sendBookingConfirmation(db, 'b1')
    expect(r.sent).toEqual(['email'])
    expect(getLocationBranding).toHaveBeenCalledWith(db, 'LOC')
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call.subject).toBe('Booked at UN1T Stillorgan')
    expect(call.htmlBody).toBe('<p>See you at Stillorgan, UN1T Stillorgan.</p>')
  })
})

// BOOKINGSELF.1 — {{manage_url}}: the booking's own cancel/reschedule page.
describe('{{manage_url}} in the booking confirmation', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('renders a signed /book/manage/ link for THIS booking', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'svc-key')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test')
    const db = {
      from(table) {
        if (table === 'email_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: { subject: 'Booked', html_content: '<a href="{{manage_url}}">Change or cancel</a>' }, error: null }) }) }) }
        return makeDb().from(table)
      },
    }
    await sendBookingConfirmation(db, 'b1')
    const href = sendTransactionalEmail.mock.calls[0][0].htmlBody.match(/href="([^"]+)"/)[1]
    expect(href).toMatch(/^https:\/\/crm\.test\/book\/manage\//)
    expect(verifyBookingManageToken(href.split('/').pop(), 'svc-key')).toEqual({ bookingId: 'b1' })
  })

  it('renders empty, and the email still goes, when no link can be built', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const db = {
      from(table) {
        if (table === 'email_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: { subject: 'Booked', html_content: '[{{manage_url}}]' }, error: null }) }) }) }
        return makeDb().from(table)
      },
    }
    const r = await sendBookingConfirmation(db, 'b1')
    expect(r.sent).toEqual(['email'])
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toBe('[]')
  })
})

describe('event reminder email', () => {
  it('renders {{company_name}} and {{location_name}} for the reminder location', async () => {
    const db = makeDb()
    const out = await sendEmailReminder(db, booking(), { eventName: 'Consultation', locationId: 'LOC', emailTemplateId: 'tpl-1', emailSubject: null })
    expect(out).toEqual({ status: 'sent' })
    const call = sendTransactionalEmail.mock.calls[0][0]
    expect(call.subject).toBe('Booked at UN1T Stillorgan')
    expect(call.htmlBody).toBe('<p>See you at Stillorgan, UN1T Stillorgan.</p>')
    expect(call.locationId).toBe('LOC')
  })
})
