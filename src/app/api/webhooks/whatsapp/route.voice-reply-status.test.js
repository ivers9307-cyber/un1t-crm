// VOICEREPLY.1 — a voice reply WhatsApp fails to deliver is resent once as
// text. Harness copied from route.voice-note.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  refreshWindow: vi.fn(),
  parseConsentKeyword: vi.fn(() => null),
  pickInboundContact: vi.fn(() => null),
  markUndeliverableIfPermanent: vi.fn(),
}))
vi.mock('@/lib/whatsapp-consent', () => ({ applyWhatsappConsentKeyword: vi.fn(), applyMetaUserPreference: vi.fn() }))
vi.mock('@/lib/whatsapp-flow/completion.js', () => ({ handleFlowCompletion: vi.fn(), publishFlowClassBooking: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp-flow/booking-notice', () => ({
  FLOW_SUBMISSION_BODY: '[Booking submitted via WhatsApp Flow]',
  FLOW_UNPROCESSED_BODY: '[Booking form submitted but could not be processed]',
  sendFlowSubmissionReply: vi.fn(async () => ({ sent: true })),
}))
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
vi.mock('@/lib/agent/auto-reply', () => ({ maybeAutoReply: vi.fn(async () => ({ handled: false })), markVoiceNoteForStaff: vi.fn(async () => {}) }))
vi.mock('@/lib/wa-voice/reply-fallback', () => ({ resendVoiceReplyAsText: vi.fn(async () => ({ resent: true })) }))
vi.mock('@/lib/wa-voice/transcribe', async (importOriginal) => ({ ...(await importOriginal()), transcribeInboundVoiceNote: vi.fn() }))
vi.mock('@/lib/agent/welcome-greeting', () => ({ maybeSendWelcomeGreeting: vi.fn() }))
vi.mock('@/lib/whatsapp-template-events', () => ({ applyTemplateEvent: vi.fn(async () => ({ template: null, notify: null })) }))
vi.mock('@/lib/whatsapp-number-events', () => ({ NUMBER_EVENT_FIELDS: new Set(), applyNumberEvent: vi.fn() }))
vi.mock('@/lib/whatsapp-flow-events', () => ({ FLOW_EVENT_FIELDS: new Set(), applyFlowEvent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ recordCtwaTouch: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ pricingColumnsFromStatus: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn(async () => 'loc-still/msg-row-1.ogg') }))
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn(), extractInboundBsuid: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-coexistence', () => ({
  parseEchoMessages: vi.fn(() => []),
  parseSyncContacts: vi.fn(() => []),
  parseHistoryMessages: vi.fn(() => []),
  nextHistorySyncState: vi.fn(),
}))
vi.mock('@/lib/whatsapp-coexistence-ingest', () => ({ syncContactMatchOnly: vi.fn(), ingestCoexistenceMessage: vi.fn() }))
vi.mock('@/lib/wa-studio-pick/resolve', () => ({ resolveNewSenderStudio: vi.fn(async () => ({ action: 'skip' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))

const PNI = '1233588839827698'
import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { resendVoiceReplyAsText } from '@/lib/wa-voice/reply-fallback'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'

function makeDb(handlers = {}) {
  const calls = []
  const from = vi.fn((table) => {
    const ops = []
    const finish = (terminal) => {
      calls.push({ table, ops, terminal })
      const h = handlers[table]
      return (typeof h === 'function' ? h(ops, terminal) : h) || { data: null, error: null }
    }
    const b = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'order', 'limit', 'insert', 'update', 'upsert', 'delete', 'gte']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.single = async () => finish('single')
    b.maybeSingle = async () => finish('maybeSingle')
    b.then = (onFulfilled, onRejected) => Promise.resolve(finish('await')).then(onFulfilled, onRejected)
    return b
  })
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })), calls }
}

const STILLORGAN = { source: 'db', id: 'wn-1', locationId: 'loc-still', homeLocationId: 'loc-still', phoneNumberId: PNI, token: 'tok' }
const statusEvent = (status) => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PNI },
  statuses: [{ id: 'wamid.v1', status, timestamp: '1770000000', recipient_id: '353871234567', ...(status === 'failed' ? { errors: [{ code: 131053, title: 'Media upload error' }] } : {}) }],
} }] }] })
const reqFor = (body) => ({ text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } })
const VOICE_ROW = { id: 'm-1', broadcast_id: null, contact_id: 'c-1', body: 'Booked you in.', voice_kind: 'booking', voice_fallback_sent_at: null, conversation_id: 'conv-1', location_id: 'loc-still' }

let row
beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  row = VOICE_ROW
  const db = makeDb({ whatsapp_messages: (ops, terminal) => (terminal === 'maybeSingle' ? { data: row, error: null } : { data: null, error: null }) })
  createServerClient.mockReturnValue(db)
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
})
afterEach(() => vi.restoreAllMocks())

describe('VOICEREPLY.1 — failed status on a voice reply', () => {
  it('resends the text once for a failed voice reply', async () => {
    const res = await POST(reqFor(statusEvent('failed')))
    expect(res.status).toBe(200)
    expect(resendVoiceReplyAsText).toHaveBeenCalledTimes(1)
    expect(resendVoiceReplyAsText.mock.calls[0][1]).toMatchObject({ id: 'm-1', voice_kind: 'booking', body: 'Booked you in.' })
  })
  it('a failed status on any other message does not', async () => {
    row = { ...VOICE_ROW, voice_kind: null }
    await POST(reqFor(statusEvent('failed')))
    expect(resendVoiceReplyAsText).not.toHaveBeenCalled()
  })
  it('delivered and read do not', async () => {
    await POST(reqFor(statusEvent('delivered')))
    await POST(reqFor(statusEvent('read')))
    expect(resendVoiceReplyAsText).not.toHaveBeenCalled()
  })
  it('a resend that throws still answers 200', async () => {
    resendVoiceReplyAsText.mockRejectedValueOnce(new Error('boom'))
    expect((await POST(reqFor(statusEvent('failed')))).status).toBe(200)
  })
})
