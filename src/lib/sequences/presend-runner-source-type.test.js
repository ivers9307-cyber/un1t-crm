// PRESEND.1 (review, CRITICAL) — the runner's due-row select decides what the
// send handlers can see, and it never fetched `source_type`.
//
// The row it SELECTs is passed verbatim to sendEmailStep / sendWhatsappStep /
// sendSmsStep as `enrollment`, and `isTransactionalEnrolment(enrollment)` reads
// exactly that column. Missing it, the predicate was ALWAYS false on the live
// runner path. Two consequences, one new and one that had been live for weeks:
//
//   - PRESEND.1's dunning pre-send gate would have proceeded on every send,
//     i.e. shipped as dead code in prod while passing every unit test, because
//     the unit tests hand the handler an enrollment object built by hand.
//   - DUNNING.3's transactional lane (marketing-consent bypass + frequency-cap
//     bypass for a dunning run) had NEVER applied on the scheduler path. A
//     member opted out of marketing at that location would have had their
//     payment reminder silently skipped as a consent failure.
//
// `enrolled_at` was missing for the same reason and with the same shape of
// consequence: isGoalMet's 'booked_since_enrolment' goal fails CLOSED without
// it (scheduler.js:320), so that goal could never exit anybody.
//
// The lesson is the test, not the column: these assertions cross the select
// boundary. One pins the column list the fake receives; the other drives the
// whole runner with the real step handlers and checks the gate was genuinely
// reached.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
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
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T' })) }))
vi.mock('@/lib/twilio', () => ({ sendLocationSms: vi.fn(), TwilioError: class TwilioError extends Error {} }))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  getGlofoxInvoicePaymentLink: vi.fn(),
  getGlofoxOverdueInvoices: vi.fn(),
  GLOFOX_OVERDUE_INVOICES_PAGE_CAP: 20,
}))
vi.mock('./enrollment-status.js', () => ({ setEnrollmentStatus: vi.fn() }))

import { runSequences } from './scheduler.js'
import { createServerClient } from '@/lib/supabase'
import { sendTemplateMessage } from '@/lib/whatsapp'
import { glofoxCredentialsForLocation, getGlofoxOverdueInvoices } from '@/lib/glofox'
import { setEnrollmentStatus } from './enrollment-status.js'

const INVOICE = '0f187762-acc8-42d2-860c-43cbe1477df0'
const MEMBER = '679bfd4c2f6535e4f200078e'
const CREDS = { branchId: 'b', apiKey: 'k', apiToken: 't' }

const enrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 1, error_count: 0, status: 'active',
  source_type: 'invoice_past_due', source_ref: INVOICE,
  enrolled_at: '2026-09-10T09:00:00Z',
  metadata: { payment: { invoice_id: INVOICE, link: 'https://pay.test/x', link_suffix: 'x', amount: '€209' } },
}

const steps = [
  { id: 'st-2', step_order: 2, step_type: 'whatsapp', whatsapp_template_id: 'tpl-1', whatsapp_variables: {}, config: {}, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
]

const contactRow = {
  id: 'c1', location_id: 'loc-1', email: 'a@x.ie', wa_phone: '+353871234567',
  glofox_member_id: MEMBER, wa_status: 'active', email_status: 'active', email_suppressed_at: null,
  contact_preferences: [{ unsubscribe_token: 'tok-1' }],
  // Deliberately OPTED OUT of marketing: a dunning run must still reach them,
  // which is the DUNNING.3 lane that source_type gates.
  contact_location_preferences: [{ location_id: 'loc-1', email_marketing: false, whatsapp_marketing: false, sms_marketing: false }],
}

function makeDb(route) {
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

const has = (state, method) => state.ops.some(o => o.method === method)
const eqArg = (state, col) => state.ops.find(o => o.method === 'eq' && o.args[0] === col)?.args[1]

const route = (state) => {
  if (state.table === 'sequence_enrollments') {
    const first = state.ops[0]
    if (first.method === 'select') return { data: [enrollment] }
    if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: 'en-1' }] }
    if (first.method === 'update') return { data: [{ id: 'en-1' }] }
    return {}
  }
  if (state.table === 'email_sequences') {
    return { data: { id: 'seq-1', name: 'Overdue payment', status: 'active', location_id: 'loc-1', goal_config: null, send_window: null } }
  }
  if (state.table === 'contacts') return { data: contactRow }
  if (state.table === 'locations') return { data: { id: 'loc-1', name: 'Stillorgan', settings: {}, features: null } }
  if (state.table === 'sequence_steps') {
    const order = eqArg(state, 'step_order')
    return { data: steps.find(s => s.step_order === order) ?? null }
  }
  if (state.table === 'whatsapp_templates') {
    return { data: { id: 'tpl-1', name: 'outstanding_payment_link_', language: 'en', status: 'APPROVED', category: 'UTILITY', location_id: 'loc-1', components: [] } }
  }
  if (state.table === 'whatsapp_messages') return { data: { id: 'msg-1' } }
  return {}
}

// The due-row select: the only sequence_enrollments select with no `eq('id')`.
function dueSelect(statements) {
  return statements.find(s => s.table === 'sequence_enrollments'
    && s.ops[0]?.method === 'select' && has(s, 'lte'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(glofoxCredentialsForLocation).mockResolvedValue(CREDS)
  vi.mocked(setEnrollmentStatus).mockResolvedValue(undefined)
  vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [INVOICE], error: null })
})

describe('runSequences — the due-row select carries the columns the handlers read', () => {
  it('selects source_type, source_ref and enrolled_at', async () => {
    const { db, statements } = makeDb(route)
    createServerClient.mockReturnValue(db)
    await runSequences()
    const cols = dueSelect(statements).ops[0].args[0]
    expect(cols, 'source_type missing — isTransactionalEnrolment is always false on the runner').toMatch(/\bsource_type\b/)
    expect(cols).toMatch(/\bsource_ref\b/)
    expect(cols, "enrolled_at missing — the 'booked_since_enrolment' goal fails closed").toMatch(/\benrolled_at\b/)
    // the columns it already read must survive
    for (const c of ['id', 'sequence_id', 'contact_id', 'current_step_order', 'error_count', 'status', 'metadata']) {
      expect(cols).toMatch(new RegExp(`\\b${c}\\b`))
    }
  })
})

describe('runSequences — source_type survives the select and reaches the handlers', () => {
  it('invokes the dunning pre-send gate for a real due dunning row', async () => {
    const { db } = makeDb(route)
    createServerClient.mockReturnValue(db)
    await runSequences()
    expect(getGlofoxOverdueInvoices, 'the gate never ran — source_type did not survive the select')
      .toHaveBeenCalledWith(CREDS, { memberId: MEMBER })
    // still overdue, so the reminder goes out
    expect(sendTemplateMessage).toHaveBeenCalled()
  })

  it('a settled invoice stops the send end to end, through the real runner', async () => {
    vi.mocked(getGlofoxOverdueInvoices).mockResolvedValue({ ok: true, status: 200, invoiceIds: [], error: null })
    const { db } = makeDb(route)
    createServerClient.mockReturnValue(db)
    await runSequences()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(setEnrollmentStatus).toHaveBeenCalledWith({ enrollmentId: 'en-1', status: 'exited', reason: 'invoice_settled_presend' })
  })

  it('DUNNING.3 — the transactional lane applies, so a marketing opt-out does not block a payment reminder', async () => {
    // contactRow is opted OUT of WhatsApp marketing at this location. Without
    // source_type on the row this send was skipped as a consent failure.
    const { db } = makeDb(route)
    createServerClient.mockReturnValue(db)
    await runSequences()
    expect(sendTemplateMessage).toHaveBeenCalled()
  })
})
