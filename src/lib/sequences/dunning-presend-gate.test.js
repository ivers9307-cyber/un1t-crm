// PRESEND.1 — the dunning pre-send gate, wired into the three send handlers.
//
// The overdue-payment reminder run is exited today only by the Glofox invoice
// webhook (PAID / FORGIVEN -> exitDunningForContact). A late or failed webhook
// means a member who has already paid still receives the day-3 email and the
// day-7 WhatsApp. So immediately before each dunning send the handler re-asks
// Glofox whether THIS invoice is still on the member's overdue list.
//
// The gate must be invisible to everything that is not a dunning run: no
// Glofox call, no extra latency, no behaviour change.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendMarketingEmail: vi.fn(async () => ({ messageId: 'pm-1' })),
  sendTransactionalEmail: vi.fn(async () => ({ messageId: 'pm-2' })),
  applyMergeTags: vi.fn((s) => s),
  buildUnsubscribeUrl: vi.fn((c, baseUrl) => `${baseUrl}/unsubscribe/tok-1`),
  appendUnsubscribeFooter: vi.fn((html) => html),
}))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://crm.test') }))
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.abc' })),
  buildTemplateComponents: vi.fn(() => []),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
  renderTemplateBody: vi.fn(() => 'rendered'),
}))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T' })),
}))
vi.mock('@/lib/twilio', () => ({
  sendLocationSms: vi.fn(async () => ({ sid: 'SM1' })), TwilioError: class TwilioError extends Error {},
}))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxInvoicePaymentLink: vi.fn(),
  getGlofoxOverdueInvoices: vi.fn(),
  GLOFOX_OVERDUE_INVOICES_PAGE_CAP: 20,
}))
vi.mock('@/lib/sequences/enrollment-status', () => ({ setEnrollmentStatus: vi.fn() }))

import { sendEmailStep, sendWhatsappStep, sendSmsStep } from './steps.js'
import { sendMarketingEmail } from '@/lib/postmark'
import { sendTemplateMessage } from '@/lib/whatsapp'
import { sendLocationSms } from '@/lib/twilio'
import { glofoxCredentialsForLocation, getGlofoxOverdueInvoices } from '@/lib/glofox'
import { setEnrollmentStatus } from '@/lib/sequences/enrollment-status'

const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const MEMBER = '679bfd4c2f6535e4f200078e'
const CREDS = { branchId: 'b', apiKey: 'k', apiToken: 't' }

function makeDb(route = () => ({})) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
    rpc() { return Promise.resolve({ error: null }) },
  }
  return { db, statements }
}

const route = (state) => {
  if (state.table === 'whatsapp_templates') {
    return { data: { id: 'tpl-1', name: 'outstanding_payment_link_', language: 'en', status: 'APPROVED', category: 'UTILITY', location_id: 'loc-1', components: [] } }
  }
  if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
  if (state.table === 'locations') return { data: { id: 'loc-1', name: 'Stillorgan', twilio_alpha_sender_id: null, features: null, settings: {} } }
  return {}
}

const sequence = { id: 'seq-1', name: 'Overdue membership payment', location_id: 'loc-1' }
const emailStep = { id: 'st-1', step_order: 3, subject: 'Still outstanding', html_content: '<p>hi</p>' }
const waStep = { id: 'st-2', step_order: 2, whatsapp_template_id: 'tpl-1', whatsapp_variables: {} }
const smsStep = { id: 'st-3', step_order: 4, sms_body: 'hi' }

const contact = {
  id: 'c1', email: 'a@x.ie', phone: '+353871234567', wa_phone: '+353871234567',
  glofox_member_id: MEMBER,
  email_status: 'active', email_suppressed_at: null, wa_status: 'active', sms_status: 'active',
  contact_preferences: [{ unsubscribe_token: 'tok-1' }],
  contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, whatsapp_marketing: true, sms_marketing: true }],
}

const dunningRun = { id: 'e1', source_type: 'invoice_past_due', metadata: { payment: { invoice_id: INVOICE, link: 'https://pay.test/x', link_suffix: 'x', amount: '€209' } } }
const marketingRun = { id: 'e2', source_type: 'audience_match', metadata: {} }

const skipRows = (statements) => statements
  .filter(s => s.table === 'activities' && s.ops[0]?.method === 'insert')
  .map(s => s.ops[0].args[0])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(glofoxCredentialsForLocation).mockResolvedValue(CREDS)
  vi.mocked(setEnrollmentStatus).mockResolvedValue(undefined)
})

describe('PRESEND.1 — a settled invoice stops the send on every channel', () => {
  beforeEach(() => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [], error: null })
  })

  it('WhatsApp: nothing is sent, the skip is on the timeline, the run is exited', async () => {
    const { db, statements } = makeDb(route)
    const r = await sendWhatsappStep(db, { enrollment: dunningRun, step: waStep, sequence, contact, frequencyCap: { enabled: false } })
    expect(r).toBeNull()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(skipRows(statements).some(a => /no longer overdue/.test(a.subject))).toBe(true)
    expect(setEnrollmentStatus).toHaveBeenCalledWith({ enrollmentId: 'e1', status: 'exited', reason: 'invoice_settled_presend' })
  })

  it('email: nothing is sent, the skip is on the timeline', async () => {
    const { db, statements } = makeDb(route)
    const r = await sendEmailStep(db, { enrollment: dunningRun, step: emailStep, sequence, contact, frequencyCap: { enabled: false } })
    expect(r).toBeNull()
    expect(sendMarketingEmail).not.toHaveBeenCalled()
    expect(skipRows(statements).some(a => /no longer overdue/.test(a.subject))).toBe(true)
  })

  it('SMS: nothing is sent', async () => {
    const { db } = makeDb(route)
    const r = await sendSmsStep(db, { enrollment: dunningRun, step: smsStep, sequence, contact })
    expect(r).toBeNull()
    expect(sendLocationSms).not.toHaveBeenCalled()
  })
})

describe('PRESEND.1 — a still-overdue invoice sends exactly as before', () => {
  beforeEach(() => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [INVOICE], error: null })
  })

  it('WhatsApp still goes out', async () => {
    const { db } = makeDb(route)
    await sendWhatsappStep(db, { enrollment: dunningRun, step: waStep, sequence, contact, frequencyCap: { enabled: false } })
    expect(sendTemplateMessage).toHaveBeenCalled()
    expect(setEnrollmentStatus).not.toHaveBeenCalled()
  })

  it('email still goes out', async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: dunningRun, step: emailStep, sequence, contact, frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })
})

describe('PRESEND.1 — non-dunning sequences are untouched', () => {
  it('a marketing enrolment never reaches Glofox on any channel', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [], error: null })
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: marketingRun, step: emailStep, sequence, contact, frequencyCap: { enabled: false } })
    await sendWhatsappStep(db, { enrollment: marketingRun, step: waStep, sequence, contact, frequencyCap: { enabled: false } })
    await sendSmsStep(db, { enrollment: marketingRun, step: smsStep, sequence, contact })
    expect(getGlofoxOverdueInvoices).not.toHaveBeenCalled()
    expect(sendMarketingEmail).toHaveBeenCalled()
    expect(sendTemplateMessage).toHaveBeenCalled()
    expect(sendLocationSms).toHaveBeenCalled()
  })
})

describe('PRESEND.1 — fails open', () => {
  it('a Glofox outage never silences a legitimate reminder', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: false, status: 0, invoiceIds: [], error: 'timeout' })
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: dunningRun, step: emailStep, sequence, contact, frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).toHaveBeenCalled()
    expect(setEnrollmentStatus).not.toHaveBeenCalled()
  })
})
