// LOCCOMMS.5 — sequence steps must gate on the row for the SEQUENCE'S location,
// not the denormalised global column.
//
// Sequences never went through buildAudienceQuery, so the PR 3 send-path cutover
// missed them entirely and they were still reading contacts.email_marketing.
// That is wrong in BOTH directions:
//   - opted out globally but opted IN at the sequence's location (the exact
//     shape of the leads recovered in LEADCAP.1) -> wrongly SKIPPED
//   - opted in globally but opted OUT at that location -> wrongly SENT TO,
//     which is the harm this whole programme exists to prevent
//
// Latent rather than live when found: email_sends held only campaign (15,339)
// and transactional (106) rows — zero sequence emails had ever been sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendMarketingEmail: vi.fn(async () => ({ messageId: 'pm-1' })),
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
  sendLocationSms: vi.fn(), TwilioError: class TwilioError extends Error {},
}))

import { sendEmailStep, sendWhatsappStep, isTransactionalEnrolment, TRANSACTIONAL_SOURCE_TYPES } from './steps.js'
import { sendMarketingEmail } from '@/lib/postmark'
import { sendTemplateMessage } from '@/lib/whatsapp'

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
    return { data: { id: 'tpl-1', name: 'nudge', language: 'en', status: 'APPROVED', location_id: 'loc-hatch', components: [] } }
  }
  if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
  return {}
}

const sequence = { id: 'seq-1', name: 'Hatch nudge', location_id: 'loc-hatch' }
const emailStep = { id: 'st-1', step_order: 1, subject: 'Hi', html_content: '<p>Hi</p>' }
const waStep = { id: 'st-2', step_order: 2, whatsapp_template_id: 'tpl-1' }

const contact = ({ global, atHatch, atOther }) => ({
  id: 'c1',
  email: 'a@x.ie',
  wa_phone: '+353871234567',
  email_status: 'active',
  email_suppressed_at: null,
  wa_status: 'active',
  email_marketing: global,
  whatsapp_marketing: global,
  contact_preferences: [{ unsubscribe_token: 'tok-1' }],
  contact_location_preferences: [
    ...(atHatch === undefined ? [] : [{
      location_id: 'loc-hatch',
      email_marketing: atHatch, whatsapp_marketing: atHatch, sms_marketing: atHatch,
    }]),
    ...(atOther === undefined ? [] : [{
      location_id: 'loc-stillorgan',
      email_marketing: atOther, whatsapp_marketing: atOther, sms_marketing: atOther,
    }]),
  ],
})

beforeEach(() => vi.clearAllMocks())

describe('LOCCOMMS.5 — sequence steps gate on the sequence location', () => {
  it('SENDS when opted out globally but opted IN at the sequence location', async () => {
    // The LEADCAP.1 shape. Under the old global gate this person was skipped
    // even though they explicitly joined this location's list.
    const { db } = makeDb(route)
    await sendEmailStep(db, {
      enrollment: { id: 'e1' }, step: emailStep, sequence,
      contact: contact({ global: false, atHatch: true }),
      frequencyCap: { enabled: false },
    })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })

  it('SKIPS when opted in globally but opted OUT at the sequence location', async () => {
    // The dangerous direction: the old gate would have SENT to someone who
    // left this location's list.
    const { db } = makeDb(route)
    await sendEmailStep(db, {
      enrollment: { id: 'e1' }, step: emailStep, sequence,
      contact: contact({ global: true, atHatch: false }),
      frequencyCap: { enabled: false },
    })
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('SKIPS when there is no row for that location at all', async () => {
    // Row absent = that location may never send. Matches the inner join in
    // contact_location_audience, so both send paths agree.
    const { db } = makeDb(route)
    await sendEmailStep(db, {
      enrollment: { id: 'e1' }, step: emailStep, sequence,
      contact: contact({ global: true, atOther: true }),
      frequencyCap: { enabled: false },
    })
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('WhatsApp steps gate the same way', async () => {
    const { db } = makeDb(route)
    await sendWhatsappStep(db, {
      step: waStep, sequence,
      contact: contact({ global: true, atHatch: false }),
      frequencyCap: { enabled: false },
    })
    expect(sendTemplateMessage).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const { db: db2 } = makeDb(route)
    await sendWhatsappStep(db2, {
      step: waStep, sequence,
      contact: contact({ global: false, atHatch: true }),
      frequencyCap: { enabled: false },
    })
    expect(sendTemplateMessage).toHaveBeenCalled()
  })
})

// DUNNING.3 — transactional lane. A dunning enrolment (source_type
// invoice_past_due / churn_radar) is a service message about the member's
// own account: it skips the MARKETING consent gate and the frequency cap but
// keeps every hard block (on the list, bounced/complained/suppressed, wa
// opted_out/blocked/undeliverable). WhatsApp rides the lane only with a
// UTILITY-category template.
describe('DUNNING.3 — transactional enrolments skip the marketing gate, keep the hard blocks', () => {
  const txn = { id: 'e-dun', source_type: 'invoice_past_due' }
  const CAPPED = { enabled: true, minHoursBetween: 24 }
  const recentlyTouched = (c) => ({ ...c, last_marketing_touch_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
  const utilityRoute = (state) => {
    if (state.table === 'whatsapp_templates') {
      return { data: { id: 'tpl-1', name: 'outstanding_payment_', category: 'UTILITY', language: 'en', status: 'APPROVED', location_id: 'loc-hatch', components: [] } }
    }
    if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
    return {}
  }
  const marketingRoute = (state) => {
    if (state.table === 'whatsapp_templates') {
      return { data: { id: 'tpl-1', name: 'promo', category: 'MARKETING', language: 'en', status: 'APPROVED', location_id: 'loc-hatch', components: [] } }
    }
    if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
    return {}
  }

  it('EMAIL: sends to a member who opted OUT of marketing at this location, even when frequency-capped', async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: txn, step: emailStep, sequence, contact: recentlyTouched(contact({ global: false, atHatch: false })), frequencyCap: CAPPED })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })

  it("EMAIL: still skips someone NOT on this location's list", async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: txn, step: emailStep, sequence, contact: contact({ global: true, atOther: true }), frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('EMAIL: still skips bounced / complained / suppressed', async () => {
    for (const patch of [{ email_status: 'bounced' }, { email_status: 'complained' }, { email_suppressed_at: '2026-08-01T00:00:00Z' }]) {
      vi.clearAllMocks()
      const { db } = makeDb(route)
      await sendEmailStep(db, { enrollment: txn, step: emailStep, sequence, contact: { ...contact({ global: false, atHatch: false }), ...patch }, frequencyCap: { enabled: false } })
      expect(sendMarketingEmail).not.toHaveBeenCalled()
    }
  })

  it('EMAIL: a marketing enrolment to the same opted-out member is still skipped (the lane is per enrolment)', async () => {
    const { db } = makeDb(route)
    await sendEmailStep(db, { enrollment: { id: 'e1', source_type: 'trigger:tag_added' }, step: emailStep, sequence, contact: contact({ global: false, atHatch: false }), frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('WHATSAPP: sends a UTILITY template to a member who opted OUT of WhatsApp marketing, even when capped', async () => {
    const { db } = makeDb(utilityRoute)
    await sendWhatsappStep(db, { enrollment: txn, step: waStep, sequence, contact: recentlyTouched(contact({ global: false, atHatch: false })), frequencyCap: CAPPED })
    expect(sendTemplateMessage).toHaveBeenCalled()
  })

  it('WHATSAPP: a MARKETING template keeps the marketing gate even in a transactional enrolment', async () => {
    const { db } = makeDb(marketingRoute)
    await sendWhatsappStep(db, { enrollment: txn, step: waStep, sequence, contact: contact({ global: false, atHatch: false }), frequencyCap: { enabled: false } })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('WHATSAPP: still skips opted_out / blocked / undeliverable and off-list', async () => {
    for (const c of [
      { ...contact({ global: false, atHatch: false }), wa_status: 'opted_out' },
      { ...contact({ global: false, atHatch: false }), wa_status: 'blocked' },
      { ...contact({ global: false, atHatch: false }), wa_status: 'undeliverable' },
      contact({ global: true, atOther: true }),
    ]) {
      vi.clearAllMocks()
      const { db } = makeDb(utilityRoute)
      await sendWhatsappStep(db, { enrollment: txn, step: waStep, sequence, contact: c, frequencyCap: { enabled: false } })
      expect(sendTemplateMessage).not.toHaveBeenCalled()
    }
  })

  it('the manual radar reminder (churn_radar) is transactional too', () => {
    expect(isTransactionalEnrolment({ source_type: 'churn_radar' })).toBe(true)
    expect(isTransactionalEnrolment({ source_type: 'invoice_past_due' })).toBe(true)
    expect(isTransactionalEnrolment({ source_type: 'manual' })).toBe(false)
    expect(isTransactionalEnrolment(null)).toBe(false)
    expect(TRANSACTIONAL_SOURCE_TYPES).toEqual(['invoice_past_due', 'churn_radar'])
  })
})
