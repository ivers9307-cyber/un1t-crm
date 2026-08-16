// TENANT.8 (item 3b) — background senders now consult
// isFeatureEnabledAtLocation before firing a per-location send, so a
// location whose bundle_messaging/bundle_marketing (or the plain
// per-key email/whatsapp/sms toggle) is off stops a sequence from
// keeps sending regardless. Closes TENANT.6's accepted gap #2 for
// src/lib/sequences/steps.js's three send handlers.
//
// isFeatureEnabledAtLocation itself (the per-key AND bundle-OR
// semantics) is exhaustively tested in src/lib/shared-permissions.test.js
// and shared/permission-bundles.test.js — these tests only prove the
// WIRING: the handler fetches the sequence's location, calls the
// resolver with the right channel key, and records a skip (not a
// throw) rather than sending when it's denied.

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
  sendLocationSms: vi.fn(async () => ({ sid: 'SM123' })),
  TwilioError: class TwilioError extends Error {},
}))

import { sendEmailStep, sendWhatsappStep, sendSmsStep } from './steps.js'
import { sendMarketingEmail } from '@/lib/postmark'
import { sendTemplateMessage } from '@/lib/whatsapp'
import { sendLocationSms } from '@/lib/twilio'

// Chainable mock db. `features` is read fresh on every `locations`
// query so a single db instance can be reused within one test.
function makeDb({ features, activityInserts = [] } = {}) {
  const db = {
    from(table) {
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(table))
            return p.then.bind(p)
          }
          return () => b
        },
      })
      return b
    },
    rpc() { return Promise.resolve({ error: null }) },
  }
  function route(table) {
    if (table === 'locations') return { data: features === undefined ? null : { id: 'loc-1', name: 'Stillorgan', twilio_alpha_sender_id: 'UN1T', features } }
    if (table === 'whatsapp_templates') {
      return { data: { id: 'tpl-1', name: 'nudge', language: 'en', status: 'APPROVED', location_id: 'loc-1', components: [] } }
    }
    if (table === 'whatsapp_messages') return { data: { id: 'msg-row-1' } }
    if (table === 'activities') { activityInserts.push(true); return { data: { id: 'act-1' }, error: null } }
    return {}
  }
  db.activityInserts = activityInserts
  return db
}

const sequence = { id: 'seq-1', name: 'Nudge', location_id: 'loc-1' }
const emailStep = { id: 'st-1', step_order: 1, subject: 'Hi', html_content: '<p>Hi</p>' }
const waStep = { id: 'st-2', step_order: 2, whatsapp_template_id: 'tpl-1' }
const smsStep = { id: 'st-3', step_order: 3, sms_body: 'Hi there' }

const emailContact = {
  id: 'c1', email: 'a@x.ie', email_status: 'active', email_suppressed_at: null,
  contact_preferences: [{ unsubscribe_token: 'tok-1' }],
  contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, whatsapp_marketing: true, sms_marketing: true }],
}
const waContact = {
  id: 'c1', wa_phone: '+353871234567', wa_status: 'active',
  contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, whatsapp_marketing: true, sms_marketing: true }],
}
const smsContact = {
  id: 'c1', phone: '+353860000000', sms_status: 'active',
  contact_location_preferences: [{ location_id: 'loc-1', email_marketing: true, whatsapp_marketing: true, sms_marketing: true }],
}

beforeEach(() => vi.clearAllMocks())

describe('sendEmailStep — location bundle/feature gate', () => {
  it('SKIPS (not throws) when features.email is explicitly false', async () => {
    const db = makeDb({ features: { email: false } })
    const out = await sendEmailStep(db, { step: emailStep, sequence, contact: emailContact, frequencyCap: { enabled: false } })
    expect(out).toBeNull()
    expect(sendMarketingEmail).not.toHaveBeenCalled()
    expect(db.activityInserts.length).toBeGreaterThan(0)
  })

  it('SKIPS when every bundle owning `email` (bundle_messaging + bundle_marketing) is explicitly off', async () => {
    const db = makeDb({ features: { bundle_messaging: false, bundle_marketing: false } })
    const out = await sendEmailStep(db, { step: emailStep, sequence, contact: emailContact, frequencyCap: { enabled: false } })
    expect(out).toBeNull()
    expect(sendMarketingEmail).not.toHaveBeenCalled()
  })

  it('SENDS when only ONE owning bundle is off — OR semantics', async () => {
    const db = makeDb({ features: { bundle_messaging: false, bundle_marketing: true } })
    await sendEmailStep(db, { step: emailStep, sequence, contact: emailContact, frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })

  it('SENDS when the location has no features at all (back-compat: {} = everything on)', async () => {
    const db = makeDb({ features: {} })
    await sendEmailStep(db, { step: emailStep, sequence, contact: emailContact, frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })

  it('SENDS when the location row is missing entirely — defaults open, never blocks on missing data', async () => {
    const db = makeDb({ features: undefined })
    await sendEmailStep(db, { step: emailStep, sequence, contact: emailContact, frequencyCap: { enabled: false } })
    expect(sendMarketingEmail).toHaveBeenCalled()
  })
})

describe('sendWhatsappStep — location bundle/feature gate', () => {
  it('SKIPS when features.whatsapp is explicitly false', async () => {
    const db = makeDb({ features: { whatsapp: false } })
    const out = await sendWhatsappStep(db, { step: waStep, sequence, contact: waContact, frequencyCap: { enabled: false } })
    expect(out).toBeNull()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('SKIPS when every bundle owning `whatsapp` is explicitly off', async () => {
    const db = makeDb({ features: { bundle_messaging: false, bundle_marketing: false } })
    const out = await sendWhatsappStep(db, { step: waStep, sequence, contact: waContact, frequencyCap: { enabled: false } })
    expect(out).toBeNull()
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('SENDS when only one owning bundle is off — OR semantics', async () => {
    const db = makeDb({ features: { bundle_messaging: true, bundle_marketing: false } })
    await sendWhatsappStep(db, { step: waStep, sequence, contact: waContact, frequencyCap: { enabled: false } })
    expect(sendTemplateMessage).toHaveBeenCalled()
  })
})

describe('sendSmsStep — location bundle/feature gate', () => {
  it('SKIPS when features.sms is explicitly false', async () => {
    const db = makeDb({ features: { sms: false } })
    const out = await sendSmsStep(db, { step: smsStep, sequence, contact: smsContact })
    expect(out).toBeNull()
    expect(sendLocationSms).not.toHaveBeenCalled()
  })

  it('SENDS when features are all on', async () => {
    const db = makeDb({ features: {} })
    await sendSmsStep(db, { step: smsStep, sequence, contact: smsContact })
    expect(sendLocationSms).toHaveBeenCalled()
  })

  it('SKIPS when every bundle owning `sms` (bundle_messaging + bundle_marketing) is explicitly off', async () => {
    const db = makeDb({ features: { bundle_messaging: false, bundle_marketing: false } })
    const out = await sendSmsStep(db, { step: smsStep, sequence, contact: smsContact })
    expect(out).toBeNull()
    expect(sendLocationSms).not.toHaveBeenCalled()
  })
})
