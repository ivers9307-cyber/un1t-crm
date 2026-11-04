// VOICENOTE.1 — the webhook transcribes an inbound voice note between the media
// rehost and Mia's turn. Harness copied from route.flow-ack.test.js.
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

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'
import { maybeAutoReply, markVoiceNoteForStaff } from '@/lib/agent/auto-reply'
import { pickInboundContact, parseConsentKeyword } from '@/lib/whatsapp'
import { applyWhatsappConsentKeyword } from '@/lib/whatsapp-consent'
import { ensureMediaRehosted } from '@/lib/whatsapp-media-server'
import { transcribeInboundVoiceNote } from '@/lib/wa-voice/transcribe'
import { logError } from '@/lib/log'

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

const PNI = '1233588839827698'
const STILLORGAN = { source: 'db', id: 'wn-1', locationId: 'loc-still', homeLocationId: 'loc-still', phoneNumberId: PNI, token: 'tok' }
const CONTACT = { id: 'ct1', location_id: 'loc-still', name: 'Richard', phone: '+353871234567' }

const reqFor = (body) => ({ text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } })
function inbound(message) {
  return {
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: PNI },
      contacts: [{ wa_id: '353871234567', profile: { name: 'Richard' } }],
      messages: [{ id: 'wamid.flow1', from: '353871234567', timestamp: '1770000000', ...message }],
    } }] }],
  }
}
const text = () => inbound({ type: 'text', text: { body: 'hi' } })
const voice = () => inbound({ type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true } })
const image = () => inbound({ type: 'image', image: { id: 'media-2', mime_type: 'image/jpeg' } })
const previewUpdates = () => db.calls.filter((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m, p]) => m === 'update' && String(p?.last_message_preview || '').startsWith('Voice note: ')))

let db
let inboundInsert
const insertedInbound = () => db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  inboundInsert = { data: { id: 'msg-row-1' }, error: null }
  db = makeDb({
    contacts: { data: [CONTACT], error: null },
    whatsapp_conversations: (ops, terminal) => {
      if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
      // The staff push reads the thread's studio.
      if (terminal === 'single' && ops.some(([m, cols]) => m === 'select' && String(cols).includes('assigned_to'))) {
        return { data: { assigned_to: null, location_id: 'loc-still', wa_profile_name: 'Richard', contacts: null }, error: null }
      }
      return { data: null, error: null }
    },
    whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? inboundInsert : { data: null, error: null }),
  })
  createServerClient.mockReturnValue(db)
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
  pickInboundContact.mockReturnValue(CONTACT)
})
afterEach(() => vi.restoreAllMocks())


describe('VOICENOTE.1 — an inbound voice note', () => {
  it('is stored pending; a text carries no transcript status', async () => {
    transcribeInboundVoiceNote.mockResolvedValue({ status: 'ok', transcript: 'Can I book 7am?', language: 'en' })
    await POST(reqFor(voice()))
    expect(insertedInbound().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ message_type: 'audio', transcript_status: 'pending' })
    vi.clearAllMocks(); db.calls.length = 0
    await POST(reqFor(text()))
    expect(insertedInbound().ops.find(([m]) => m === 'insert')[1]).not.toHaveProperty('transcript_status')
  })

  it('is transcribed after the rehost and before Mia, who gets the result', async () => {
    const order = []
    ensureMediaRehosted.mockImplementationOnce(async () => { order.push('rehost'); return 'loc-still/msg-row-1.ogg' })
    transcribeInboundVoiceNote.mockImplementationOnce(async () => { order.push('transcribe'); return { status: 'ok', transcript: 'Can I book 7am?', language: 'en' } })
    maybeAutoReply.mockImplementationOnce(async () => { order.push('mia'); return { handled: true, action: 'reply' } })
    const res = await POST(reqFor(voice()))
    expect(res.status).toBe(200)
    expect(order).toEqual(['rehost', 'transcribe', 'mia'])
    expect(transcribeInboundVoiceNote).toHaveBeenCalledWith(db, { messageId: 'msg-row-1', locationId: 'loc-still', storagePath: 'loc-still/msg-row-1.ogg', mime: 'audio/ogg; codecs=opus' })
    expect(maybeAutoReply.mock.calls[0][1]).toMatchObject({ messageType: 'audio', voiceTranscript: { status: 'ok', text: 'Can I book 7am?' } })
  })

  it('sets the thread preview from the transcript', async () => {
    transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'ok', transcript: 'x'.repeat(120), language: 'en' })
    await POST(reqFor(voice()))
    const u = previewUpdates()
    expect(u).toHaveLength(1)
    expect(u[0].ops.find(([m]) => m === 'update')[1].last_message_preview).toBe('Voice note: ' + 'x'.repeat(80))
  })

  it('leaves the preview when there is no transcript', async () => {
    transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'too_long', transcript: null, language: null })
    await POST(reqFor(voice()))
    expect(previewUpdates()).toHaveLength(0)
  })

  it('a voice note that lost its turn goes to staff silently', async () => {
    for (const reason of ['in_flight', 'nothing_to_answer']) {
      vi.clearAllMocks()
      transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'ok', transcript: 'Can I book 7am?', language: 'en' })
      maybeAutoReply.mockResolvedValueOnce({ handled: false, reason })
      await POST(reqFor(voice()))
      expect(markVoiceNoteForStaff).toHaveBeenCalledTimes(1)
      expect(markVoiceNoteForStaff).toHaveBeenCalledWith(db, { conversationId: 'conv-1', locationId: 'loc-still' })
    }
  })

  it('a reply, or a deliberate gate, is not a lost turn', async () => {
    for (const result of [{ handled: true, action: 'reply' }, { handled: false, reason: 'quiet_hours' }, { handled: false, reason: 'disabled' }]) {
      vi.clearAllMocks()
      transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'ok', transcript: 'Can I book 7am?', language: 'en' })
      maybeAutoReply.mockResolvedValueOnce(result)
      await POST(reqFor(voice()))
      expect(markVoiceNoteForStaff).not.toHaveBeenCalled()
    }
    vi.clearAllMocks()
    transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'disabled', transcript: null, language: null })
    maybeAutoReply.mockResolvedValueOnce({ handled: false, reason: 'in_flight' })
    await POST(reqFor(voice()))
    expect(markVoiceNoteForStaff).not.toHaveBeenCalled()
  })

  it('a voice note Mia could not answer that lost the turn goes to staff silently too (review I-2)', async () => {
    for (const status of ['unclear', 'too_long', 'capped', 'failed', 'not_configured']) {
      vi.clearAllMocks()
      transcribeInboundVoiceNote.mockResolvedValueOnce({ status, transcript: status === 'unclear' ? 'mumble' : null, language: null })
      maybeAutoReply.mockResolvedValueOnce({ handled: false, reason: 'in_flight' })
      await POST(reqFor(voice()))
      expect(markVoiceNoteForStaff).toHaveBeenCalledTimes(1)
    }
  })

  it('a transcription step that throws still reaches Mia as failed; the webhook 200s', async () => {
    transcribeInboundVoiceNote.mockRejectedValueOnce(new Error('boom'))
    const res = await POST(reqFor(voice()))
    expect(res.status).toBe(200)
    expect(maybeAutoReply.mock.calls[0][1]).toMatchObject({ voiceTranscript: { status: 'failed', text: null } })
    expect(logError).toHaveBeenCalledWith('wa-webhook', expect.stringMatching(/voice transcription threw/), expect.objectContaining({ conversationId: 'conv-1' }))
  })

  it('a lost-turn hand-off that throws never fails the webhook', async () => {
    transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'ok', transcript: 'Can I book 7am?', language: 'en' })
    maybeAutoReply.mockResolvedValueOnce({ handled: false, reason: 'in_flight' })
    markVoiceNoteForStaff.mockRejectedValueOnce(new Error('boom'))
    expect((await POST(reqFor(voice()))).status).toBe(200)
  })

  it('text and image messages are never transcribed', async () => {
    await POST(reqFor(text()))
    await POST(reqFor(image()))
    expect(transcribeInboundVoiceNote).not.toHaveBeenCalled()
  })

  it('a voice note never reaches the consent keyword parser', async () => {
    parseConsentKeyword.mockReturnValue('stop')
    transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'unclear', transcript: 'stop', language: 'en' })
    await POST(reqFor(voice()))
    expect(applyWhatsappConsentKeyword).not.toHaveBeenCalled()
    parseConsentKeyword.mockReturnValue(null)
  })

  it('the staff push shows the transcript for a voice note', async () => {
    transcribeInboundVoiceNote.mockResolvedValueOnce({ status: 'unclear', transcript: 'mumble about seven', language: 'en' })
    maybeAutoReply.mockResolvedValueOnce({ handled: false, reason: 'disabled' })
    const { sendPushToRolesAtLocation } = await import('@/lib/push')
    await POST(reqFor(voice()))
    const payload = vi.mocked(sendPushToRolesAtLocation).mock.calls.at(-1)[2]
    expect(payload.body).toBe('Voice note: mumble about seven')
  })
})
