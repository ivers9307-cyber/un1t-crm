import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.OK', status: 'sent' })),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
}))

vi.mock('@/lib/whatsapp-purpose-templates', async (importOriginal) => ({
  ...(await importOriginal()),
  resolvePurposeTemplate: vi.fn(),
}))

import { maybeSendBookingWhatsappConfirm } from './booking-whatsapp-confirm'
import { sendTemplateMessage } from '@/lib/whatsapp'
import { resolvePurposeTemplate } from '@/lib/whatsapp-purpose-templates'

function makeDb(template, { features } = {}) {
  return {
    from(tbl) {
      if (tbl === 'whatsapp_templates') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: template }) }) }) }) }
      }
      if (tbl === 'contacts') return { update: () => ({ eq: () => ({ is: async () => ({}) }) }) }
      if (tbl === 'whatsapp_messages') return { insert: async () => ({}) }
      // TENANT.8 (item 3b) — bundle/feature gate reads `locations`.
      if (tbl === 'locations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'L', features: features ?? {} } }) }) }) }
      return {}
    },
  }
}
const APPROVED = { name: 'booking_consult_confirmed', status: 'APPROVED', language: 'en' }

beforeEach(() => vi.clearAllMocks())

describe('maybeSendBookingWhatsappConfirm', () => {
  it('no template name → noop', async () => {
    const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(null), locationId: 'L', contact: { phone: '0871234567' }, templateName: null, bodyParams: ['Sarah'] })
    expect(r).toEqual({ sent: false, reason: 'no_template_configured' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
  it('no phone → noop', async () => {
    const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(APPROVED), locationId: 'L', contact: {}, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'] })
    expect(r).toEqual({ sent: false, reason: 'no_phone' })
  })
  it('template not APPROVED → noop', async () => {
    const r = await maybeSendBookingWhatsappConfirm({ db: makeDb({ ...APPROVED, status: 'PENDING' }), locationId: 'L', contact: { phone: '0871234567' }, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'] })
    expect(r).toEqual({ sent: false, reason: 'template_PENDING' })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
  it('happy path → sends to E.164 with body params', async () => {
    const r = await maybeSendBookingWhatsappConfirm({
      db: makeDb(APPROVED), locationId: 'a0000000-0000-0000-0000-000000000001',
      contact: { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null },
      templateName: 'booking_consult_confirmed', bodyParams: ['Sarah', 'Tue 8 Jul, 6:30pm'],
    })
    expect(r).toEqual({ sent: true, messageId: 'wamid.OK' })
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      '+353871234567', 'booking_consult_confirmed', 'en',
      [{ type: 'body', parameters: [{ type: 'text', text: 'Sarah' }, { type: 'text', text: 'Tue 8 Jul, 6:30pm' }] }],
      { locationId: 'a0000000-0000-0000-0000-000000000001' },
    )
  })

  it('WAORGNUMBER.2: a template with a recorded WABA sends from the studio’s number on it', async () => {
    await maybeSendBookingWhatsappConfirm({
      db: makeDb({ ...APPROVED, business_account_id: 'WABA-2' }), locationId: 'a0000000-0000-0000-0000-000000000001',
      contact: { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null },
      templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'],
    })
    expect(sendTemplateMessage.mock.calls[0][4]).toEqual({ locationId: 'a0000000-0000-0000-0000-000000000001', businessAccountId: 'WABA-2' })
  })

  // WAORGNUMBER.2 (R5) — a PURPOSE resolves to the studio's own template.
  describe('purpose templates', () => {
    const HATCH = 'a0000000-0000-4000-8000-000000000002'
    const contact = { id: 'c1', first_name: 'Sarah', phone: '0871234567', wa_phone: null }

    it("uses the studio's purpose template, on that template's WABA", async () => {
      resolvePurposeTemplate.mockResolvedValueOnce({ id: 'T-H', name: 'hatch_class_ok', language: 'en-GB', category: 'UTILITY', components: [], business_account_id: 'WABA-9', header_media_url: null })
      // The db has NO template by the default name: only the resolver can supply it.
      const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(null), locationId: HATCH, contact, purpose: 'class_confirmed', bodyParams: ['Sarah', 'Spin', 'Tue 6pm'] })
      expect(r).toEqual({ sent: true, messageId: 'wamid.OK' })
      expect(resolvePurposeTemplate).toHaveBeenCalledWith(expect.anything(), HATCH, 'class_confirmed', {})
      expect(sendTemplateMessage).toHaveBeenCalledWith(
        '+353871234567', 'hatch_class_ok', 'en-GB', expect.any(Array), { locationId: HATCH, businessAccountId: 'WABA-9' },
      )
    })

    it('no template at the studio → quiet template_not_found, nothing sent', async () => {
      resolvePurposeTemplate.mockResolvedValueOnce(null)
      const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(APPROVED), locationId: HATCH, contact, purpose: 'consult_confirmed', bodyParams: ['Sarah'] })
      expect(r).toEqual({ sent: false, reason: 'template_not_found' })
      expect(sendTemplateMessage).not.toHaveBeenCalled()
    })

    it('a failed template read is a quiet send_failed, never thrown', async () => {
      resolvePurposeTemplate.mockRejectedValueOnce(new Error('read failed'))
      const r = await maybeSendBookingWhatsappConfirm({ db: makeDb(null), locationId: HATCH, contact, purpose: 'event_waitlist_offer', bodyParams: ['Sarah'] })
      expect(r).toEqual({ sent: false, reason: 'send_failed' })
      expect(sendTemplateMessage).not.toHaveBeenCalled()
    })

    it('without a purpose it still sends the named template (an event type\'s own confirmation)', async () => {
      await maybeSendBookingWhatsappConfirm({ db: makeDb(APPROVED), locationId: HATCH, contact, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'] })
      expect(resolvePurposeTemplate).not.toHaveBeenCalled()
      expect(sendTemplateMessage.mock.calls[0][1]).toBe('booking_consult_confirmed')
    })
  })

  // TENANT.8 (item 3b) — location bundle/feature gate.
  describe('location bundle/feature gate', () => {
    it('SKIPS when features.whatsapp is explicitly false', async () => {
      const r = await maybeSendBookingWhatsappConfirm({
        db: makeDb(APPROVED, { features: { whatsapp: false } }), locationId: 'L',
        contact: { phone: '0871234567' }, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'],
      })
      expect(r).toEqual({ sent: false, reason: 'bundle_disabled' })
      expect(sendTemplateMessage).not.toHaveBeenCalled()
    })

    it('SKIPS when every bundle owning `whatsapp` is explicitly off', async () => {
      const r = await maybeSendBookingWhatsappConfirm({
        db: makeDb(APPROVED, { features: { bundle_messaging: false, bundle_marketing: false } }), locationId: 'L',
        contact: { phone: '0871234567' }, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'],
      })
      expect(r).toEqual({ sent: false, reason: 'bundle_disabled' })
      expect(sendTemplateMessage).not.toHaveBeenCalled()
    })

    it('SENDS when only one owning bundle is off — OR semantics', async () => {
      const r = await maybeSendBookingWhatsappConfirm({
        db: makeDb(APPROVED, { features: { bundle_messaging: true, bundle_marketing: false } }), locationId: 'L',
        contact: { phone: '0871234567' }, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'],
      })
      expect(r.sent).toBe(true)
      expect(sendTemplateMessage).toHaveBeenCalled()
    })

    it('SENDS (fails open) when the locations read throws', async () => {
      const db = makeDb(APPROVED)
      db.from = new Proxy(db.from, {
        apply(target, thisArg, args) {
          if (args[0] === 'locations') return { select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error('down') } }) }) }
          return target.apply(thisArg, args)
        },
      })
      const r = await maybeSendBookingWhatsappConfirm({
        db, locationId: 'L', contact: { phone: '0871234567' }, templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'],
      })
      expect(r.sent).toBe(true)
      expect(sendTemplateMessage).toHaveBeenCalled()
    })
  })
})

// WACONFIGFALLBACK.1 — a booking at a location with no WhatsApp number of its
// own. The confirmation used to go out on the global env number (another
// studio's, so a reply reached THAT studio's inbox and Mia). The resolver now
// refuses; this helper's contract (never throws) turns that into a quiet
// sent:false with a structured warning. No thread is opened, and the
// booking itself is untouched (its email confirmation is a separate path).
describe('maybeSendBookingWhatsappConfirm — no WhatsApp number at the location', () => {
  it('sent:false (send_failed), never throws, no thread opened', async () => {
    const { WhatsAppNumberMissingError } = await import('@/lib/whatsapp-number-missing')
    const { getOrCreateConversation } = await import('@/lib/whatsapp')
    sendTemplateMessage.mockRejectedValueOnce(new WhatsAppNumberMissingError('L'))
    const r = await maybeSendBookingWhatsappConfirm({
      db: makeDb(APPROVED), locationId: 'L',
      contact: { id: 'c1', phone: '0871234567', wa_phone: null },
      templateName: 'booking_consult_confirmed', bodyParams: ['Sarah'],
    })
    expect(r).toEqual({ sent: false, reason: 'send_failed' })
    expect(getOrCreateConversation).not.toHaveBeenCalled()
  })
})
