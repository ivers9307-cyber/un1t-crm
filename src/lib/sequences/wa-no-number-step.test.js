// WACONFIGFALLBACK.1 — a sequence WhatsApp step at a location with no
// WhatsApp number of its own (it used to go out on the global env number) is
// a RECORDED SKIP: resolves null, one activity row, a structured warning, no
// throw. A throw would feed error_count and could auto-pause the enrolment,
// killing its email steps too. Any other send error still throws (unchanged).
// Harness copied from steps.test.js ("send-time consent gate" block).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendTransactionalEmail: vi.fn(),
  sendMarketingEmail: vi.fn(),
  applyMergeTags: vi.fn((s) => s),
  buildUnsubscribeUrl: vi.fn(() => 'https://crm.test/unsubscribe/x'),
  appendUnsubscribeFooter: vi.fn((html) => html),
}))
vi.mock('@/lib/app-url', () => ({ getAppUrl: vi.fn(() => 'https://crm.test') }))
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(),
  buildTemplateComponents: vi.fn(() => []),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
  renderTemplateBody: vi.fn(() => ''),
}))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'Studio' })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('./triggers.js', () => ({ triggerSequencesForPipelineStageChange: vi.fn() }))

const steps = await import('./steps.js')
const wa = await import('@/lib/whatsapp')
const { logWarn } = await import('@/lib/log')
const { WhatsAppNumberMissingError } = await import('@/lib/whatsapp-number-missing')

const WA_TEMPLATE = { id: 't1', status: 'APPROVED', location_id: 'loc-1', name: 'book_first_visit', language: 'en', components: [] }
const step = { id: 'step-1', step_order: 2, whatsapp_template_id: 't1', whatsapp_variables: {} }
const sequence = { id: 'seq-1', name: 'Synthetic sequence', location_id: 'loc-1' }
const contact = {
  id: 'c1', location_id: 'loc-1', wa_phone: '353860000000', whatsapp_marketing: true, wa_status: 'active',
  contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true }],
}

function makeDb() {
  const activityInserts = []
  const messageInserts = []
  const rpcCalls = []
  return {
    activityInserts, messageInserts, rpcCalls,
    from(table) {
      if (table === 'activities') return { insert: (row) => { activityInserts.push(row); return Promise.resolve({ error: null }) } }
      if (table === 'whatsapp_templates') return { select: () => ({ eq: () => ({ single: async () => ({ data: WA_TEMPLATE }) }) }) }
      if (table === 'whatsapp_messages') return { insert: (row) => { messageInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } }) }) } } }
      if (table === 'locations') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'loc-1', features: {} } }) }) }) }
      throw new Error(`unexpected table ${table}`)
    },
    rpc(name) { rpcCalls.push(name); return Promise.resolve({ data: null, error: null }) },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  wa.sendTemplateMessage.mockRejectedValue(new WhatsAppNumberMissingError('loc-1'))
})

describe('sendWhatsappStep — no WhatsApp number at the sequence location', () => {
  it('recorded skip: resolves null, one activity, structured warning, nothing logged as sent', async () => {
    const db = makeDb()
    const out = await steps.sendWhatsappStep(db, { step, sequence, contact })
    expect(out).toBeNull()
    expect(wa.sendTemplateMessage).toHaveBeenCalledWith('353860000000', 'book_first_visit', 'en', [], { locationId: 'loc-1' })
    expect(db.activityInserts).toHaveLength(1)
    expect(db.activityInserts[0].subject).toBe('Sequence WhatsApp step skipped — no WhatsApp number at this location')
    expect(logWarn).toHaveBeenCalledWith('sequences', 'WhatsApp step skipped: no WhatsApp number at the sequence location', {
      sequenceId: 'seq-1', stepId: 'step-1', contactId: 'c1', locationId: 'loc-1',
    })
    expect(db.messageInserts).toEqual([])
    expect(db.rpcCalls).not.toContain('increment_step_sent')
  })

  it('any other send error still throws (a Meta rejection is not a setup gap)', async () => {
    wa.sendTemplateMessage.mockRejectedValue(new Error('(#131026) Message undeliverable'))
    await expect(steps.sendWhatsappStep(makeDb(), { step, sequence, contact })).rejects.toThrow(/131026/)
  })
})
