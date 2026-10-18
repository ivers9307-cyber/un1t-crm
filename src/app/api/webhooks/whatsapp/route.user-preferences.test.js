// WAORGNUMBER.3 (R6) — Meta's user_preferences webhook is applied for the
// organisation of the number it ARRIVED on: the route resolves the receiving
// studio from metadata.phone_number_id and hands it to applyMetaUserPreference,
// whose contact lookup is bounded to that studio's organisation. A number that
// resolves to no studio passes null (nothing is applied; the module refuses).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  refreshWindow: vi.fn(),
  parseConsentKeyword: vi.fn(() => null),
  pickInboundContact: vi.fn(() => null),
  markUndeliverableIfPermanent: vi.fn(),
}))
vi.mock('@/lib/whatsapp-consent', () => ({ applyWhatsappConsentKeyword: vi.fn(), applyMetaUserPreference: vi.fn() }))
vi.mock('@/lib/whatsapp-flow/completion.js', () => ({ handleFlowCompletion: vi.fn() }))
vi.mock('@/lib/whatsapp-config', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
  getLocationWhatsAppNumberConfig: vi.fn(async () => null),
}))
vi.mock('@/lib/webhook-auth', () => ({ verifyMetaSignature: vi.fn(() => ({ ok: true })), safeEqual: vi.fn(() => true) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/schemas', () => ({ MANAGER_ROLES: ['owner', 'manager', 'head_coach'] }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(async () => ({ seen: false })),
  WEBHOOK_PROVIDERS: { WHATSAPP: 'whatsapp' },
}))
vi.mock('@/lib/agent/auto-reply', () => ({ maybeAutoReply: vi.fn(async () => ({ handled: false })) }))
vi.mock('@/lib/agent/welcome-greeting', () => ({ maybeSendWelcomeGreeting: vi.fn() }))
vi.mock('@/lib/whatsapp-template-events', () => ({ applyTemplateEvent: vi.fn(async () => ({ template: null, notify: null })) }))
// The REAL NUMBER_EVENT_FIELDS — the whole point of this file. applyNumberEvent
// is the real implementation wrapped in a spy so one test can make it throw.
vi.mock('@/lib/whatsapp-number-events', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyNumberEvent: vi.fn(actual.applyNumberEvent) }
})
vi.mock('@/lib/whatsapp-flow-events', () => ({ FLOW_EVENT_FIELDS: new Set(), applyFlowEvent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ recordCtwaTouch: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ pricingColumnsFromStatus: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn() }))
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn() }))
// `@/lib/whatsapp-coexistence` is deliberately NOT mocked: parseAccountUpdateEvent,
// nextCoexistenceLinkState and COEX_LINK_EVENTS are the real pure helpers.
vi.mock('@/lib/whatsapp-coexistence-ingest', () => ({ syncContactMatchOnly: vi.fn(), ingestCoexistenceMessage: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { applyMetaUserPreference } from '@/lib/whatsapp-consent'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'

const envelope = (value) => ({ entry: [{ id: '100000000000001', changes: [{ field: 'user_preferences', value }] }] })
const reqFor = (body) => ({ text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } })
const PREF = { wa_id: '353871234567', category: 'marketing_messages', value: 'stop' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  createServerClient.mockReturnValue({ from: vi.fn(), rpc: vi.fn() })
})
afterEach(() => { vi.restoreAllMocks() })

describe('user_preferences — scoped to the receiving number\'s studio', () => {
  it('passes the number\'s HOME studio to applyMetaUserPreference', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue({ source: 'db', id: 'wn1', homeLocationId: 'loc-home' })
    applyMetaUserPreference.mockResolvedValue({ applied: true })
    const res = await POST(reqFor(envelope({ metadata: { phone_number_id: 'pn1' }, user_preferences: [PREF] })))
    expect(res.status).toBe(200)
    expect(resolveWhatsAppNumberByPhoneNumberId).toHaveBeenCalledWith('pn1')
    expect(applyMetaUserPreference).toHaveBeenCalledWith(expect.anything(), PREF, 'loc-home')
  })

  it('an unroutable number passes NO studio, and the miss is logged loudly', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(null)
    applyMetaUserPreference.mockResolvedValue({ applied: false, reason: 'no_receiving_studio' })
    const res = await POST(reqFor(envelope({ metadata: { phone_number_id: 'pn-unknown' }, user_preferences: [PREF] })))
    expect(res.status).toBe(200)
    expect(applyMetaUserPreference).toHaveBeenCalledWith(expect.anything(), PREF, null)
    expect(console.error.mock.calls.some((c) => String(c[0]).includes('resolves to no studio'))).toBe(true)
  })

  it('a failed number lookup is a studio-less pass, never a throw out of the webhook', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockRejectedValue(new Error('db down'))
    applyMetaUserPreference.mockResolvedValue({ applied: false, reason: 'no_receiving_studio' })
    const res = await POST(reqFor(envelope({ metadata: { phone_number_id: 'pn1' }, user_preferences: [PREF] })))
    expect(res.status).toBe(200)
    expect(applyMetaUserPreference).toHaveBeenCalledWith(expect.anything(), PREF, null)
  })
})
