import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.OK', status: 'sent' })),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
}))

import { maybeSendBookingWhatsappConfirm } from './booking-whatsapp-confirm'
import { sendTemplateMessage } from '@/lib/whatsapp'

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
