// FREQ-CAP.1 — sequence step handlers under the marketing frequency cap.
//
// Locks in the load-bearing properties:
//   1. A capped contact makes the email/WhatsApp handler throw
//      FrequencyCapDeferral BEFORE any provider call — nothing is sent,
//      so the scheduler's deferral can never create a re-send loop.
//   2. Gate ORDER: consent/hygiene gates win over the cap. A contact who
//      is both unconsented AND capped is a recorded SKIP (cursor
//      advances) — never deferred, never stamped.
//   3. A successful marketing send stamps contacts.last_marketing_touch_at
//      even while the cap is DISABLED (history for a later enable).
//   4. A disabled cap never blocks a send.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendMarketingEmail: vi.fn(async () => ({ messageId: 'pm-1' })),
  applyMergeTags: vi.fn((s) => s),
  buildUnsubscribeUrl: vi.fn((contact, baseUrl) => `${baseUrl}/unsubscribe/tok-1`),
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
  sendLocationSms: vi.fn(),
  TwilioError: class TwilioError extends Error {},
}))

import { sendEmailStep, sendWhatsappStep } from './steps.js'
import { FrequencyCapDeferral } from '@/lib/frequency-cap'
import { sendMarketingEmail } from '@/lib/postmark'
import { sendTemplateMessage } from '@/lib/whatsapp'

// Chainable recorder db (the campaign-sender.test.js idiom): every
// db.from() records a statement; awaiting the chain resolves route(state).
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
    rpc(...args) {
      statements.push({ table: '__rpc__', ops: [{ method: 'rpc', args }] })
      return Promise.resolve({ error: null })
    },
  }
  return { db, statements }
}

const route = (state) => {
  if (state.table === 'whatsapp_templates') {
    return {
      data: {
        id: 'tpl-1', name: 'nudge', language: 'en', status: 'APPROVED',
        location_id: 'loc-1', components: [],
      },
    }
  }
  if (state.table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
  return {}
}

const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60_000).toISOString()
const CAP_ON = { enabled: true, minHoursBetween: 24 }
const CAP_OFF = { enabled: false, minHoursBetween: 24 }

const emailContact = (overrides = {}) => ({
  id: 'c1',
  email: 'a@x.ie',
  email_marketing: true,
  email_status: 'active',
  email_suppressed_at: null,
  contact_preferences: [{ unsubscribe_token: 'tok-1' }],
  // LOCCOMMS.5 — steps gate on the row for sequence.location_id ('loc-1').
  // Without it the gate correctly refuses to send, which is what made these
  // tests fail when the per-location gate landed.
  contact_location_preferences: [{
    location_id: 'loc-1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true,
  }],
  ...overrides,
})
const waContact = (overrides = {}) => ({
  id: 'c1',
  wa_phone: '+353871234567',
  whatsapp_marketing: true,
  wa_status: 'active',
  contact_location_preferences: [{
    location_id: 'loc-1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true,
  }],
  ...overrides,
})
const sequence = { id: 'seq-1', name: 'Nudge', location_id: 'loc-1' }
const emailStep = { id: 'st-1', step_order: 1, subject: 'Hi', html_content: '<p>Hi</p>' }
const waStep = { id: 'st-2', step_order: 2, whatsapp_template_id: 'tpl-1' }

const touchStamps = (statements) =>
  statements.filter(s =>
    s.table === 'contacts' &&
    s.ops[0]?.method === 'update' &&
    'last_marketing_touch_at' in s.ops[0].args[0]
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendEmailStep — frequency cap', () => {
  it('throws FrequencyCapDeferral BEFORE sending when the contact is capped', async () => {
    const { db, statements } = makeDb(route)
    const contact = emailContact({ last_marketing_touch_at: hoursAgo(2) })

    await expect(
      sendEmailStep(db, { enrollment: {}, step: emailStep, sequence, contact, frequencyCap: CAP_ON })
    ).rejects.toBeInstanceOf(FrequencyCapDeferral)

    expect(sendMarketingEmail).not.toHaveBeenCalled()
    expect(touchStamps(statements)).toHaveLength(0)
  })

  it('deferUntil lands after the window clears (plus bounded jitter)', async () => {
    const { db } = makeDb(route)
    const contact = emailContact({ last_marketing_touch_at: hoursAgo(20) })
    let deferral
    try {
      await sendEmailStep(db, { enrollment: {}, step: emailStep, sequence, contact, frequencyCap: CAP_ON })
    } catch (e) { deferral = e }
    const t = new Date(deferral.deferUntil).getTime()
    const clears = Date.now() + 4 * 60 * 60_000
    expect(t).toBeGreaterThanOrEqual(clears - 1000)
    expect(t).toBeLessThan(clears + 5 * 60_000 + 1000)
  })

  it('consent gate wins over the cap: unconsented + capped = recorded SKIP, not deferral', async () => {
    const { db, statements } = makeDb(route)
    const contact = emailContact({ email_marketing: false, contact_location_preferences: [{ location_id: 'loc-1', email_marketing: false, sms_marketing: false, whatsapp_marketing: false }], last_marketing_touch_at: hoursAgo(2) })

    const result = await sendEmailStep(db, { enrollment: {}, step: emailStep, sequence, contact, frequencyCap: CAP_ON })

    expect(result).toBeNull() // recordStepSkip path — cursor advances
    expect(sendMarketingEmail).not.toHaveBeenCalled()
    const skipNote = statements.find(s => s.table === 'activities' && s.ops[0]?.method === 'insert')
    expect(skipNote).toBeTruthy()
    expect(touchStamps(statements)).toHaveLength(0)
  })

  it('a disabled cap never blocks, and a successful send stamps the touch anyway', async () => {
    const { db, statements } = makeDb(route)
    const contact = emailContact({ last_marketing_touch_at: hoursAgo(1) }) // "capped" if it were on

    const sendId = await sendEmailStep(db, { enrollment: {}, step: emailStep, sequence, contact, frequencyCap: CAP_OFF })

    expect(sendMarketingEmail).toHaveBeenCalledTimes(1)
    expect(sendId).toBe('pm-1')
    const stamps = touchStamps(statements)
    expect(stamps).toHaveLength(1)
    expect(stamps[0].ops.find(o => o.method === 'in').args[1]).toEqual(['c1'])
  })

  it('an out-of-window contact sends normally with the cap enabled', async () => {
    const { db, statements } = makeDb(route)
    const contact = emailContact({ last_marketing_touch_at: hoursAgo(30) })

    await sendEmailStep(db, { enrollment: {}, step: emailStep, sequence, contact, frequencyCap: CAP_ON })

    expect(sendMarketingEmail).toHaveBeenCalledTimes(1)
    expect(touchStamps(statements)).toHaveLength(1)
  })

  it('no frequencyCap in ctx (older caller) behaves as uncapped', async () => {
    const { db } = makeDb(route)
    const contact = emailContact({ last_marketing_touch_at: hoursAgo(1) })
    await sendEmailStep(db, { enrollment: {}, step: emailStep, sequence, contact })
    expect(sendMarketingEmail).toHaveBeenCalledTimes(1)
  })
})

describe('sendWhatsappStep — frequency cap', () => {
  it('throws FrequencyCapDeferral BEFORE sending when the contact is capped', async () => {
    const { db, statements } = makeDb(route)
    const contact = waContact({ last_marketing_touch_at: hoursAgo(2) })

    await expect(
      sendWhatsappStep(db, { step: waStep, sequence, contact, frequencyCap: CAP_ON })
    ).rejects.toBeInstanceOf(FrequencyCapDeferral)

    expect(sendTemplateMessage).not.toHaveBeenCalled()
    // The deferral fires before the template is even fetched.
    expect(statements.some(s => s.table === 'whatsapp_templates')).toBe(false)
    expect(touchStamps(statements)).toHaveLength(0)
  })

  it('consent gate wins over the cap: opted-out + capped = recorded SKIP', async () => {
    const { db, statements } = makeDb(route)
    const contact = waContact({ wa_status: 'opted_out', last_marketing_touch_at: hoursAgo(2) })

    const result = await sendWhatsappStep(db, { step: waStep, sequence, contact, frequencyCap: CAP_ON })

    expect(result).toBeNull()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(touchStamps(statements)).toHaveLength(0)
  })

  it('a successful send stamps the touch (cap disabled too) and returns OUR row id', async () => {
    const { db, statements } = makeDb(route)
    const contact = waContact({ last_marketing_touch_at: hoursAgo(30) })

    const sendId = await sendWhatsappStep(db, { step: waStep, sequence, contact, frequencyCap: CAP_ON })

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(sendId).toBe('msg-row-1') // our uuid, never the wamid (22P02 class)
    const stamps = touchStamps(statements)
    expect(stamps).toHaveLength(1)
    expect(stamps[0].ops.find(o => o.method === 'in').args[1]).toEqual(['c1'])
  })
})
