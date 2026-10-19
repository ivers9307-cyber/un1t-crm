// FLOWACK.1 — a completed WhatsApp booking Flow is not a message for Mia.
//
// Incident (19 Oct 2026, Hatch Street): the webhook threw away
// handleFlowCompletion's result, stored the inbound as an `interactive`
// "[Booking submitted via WhatsApp Flow]" and handed it to Mia, who told the
// customer "you're all set for your first visit" 4 seconds after the booking
// had FAILED. Now a handled submission gets ONE honest acknowledgement (class:
// "we're booking your spot now"; consult, booked on submit: the confirmation)
// and no Mia turn; the processors send the real outcome later. A submission
// that was NOT handled still reaches Mia (and staff), as before.
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
vi.mock('@/lib/agent/auto-reply', () => ({ maybeAutoReply: vi.fn(async () => ({ handled: false })) }))
vi.mock('@/lib/agent/welcome-greeting', () => ({ maybeSendWelcomeGreeting: vi.fn() }))
vi.mock('@/lib/whatsapp-template-events', () => ({ applyTemplateEvent: vi.fn(async () => ({ template: null, notify: null })) }))
vi.mock('@/lib/whatsapp-number-events', () => ({ NUMBER_EVENT_FIELDS: new Set(), applyNumberEvent: vi.fn() }))
vi.mock('@/lib/whatsapp-flow-events', () => ({ FLOW_EVENT_FIELDS: new Set(), applyFlowEvent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ recordCtwaTouch: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ pricingColumnsFromStatus: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn() }))
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
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { pickInboundContact } from '@/lib/whatsapp'
import { handleFlowCompletion, publishFlowClassBooking } from '@/lib/whatsapp-flow/completion.js'
import { sendFlowSubmissionReply } from '@/lib/whatsapp-flow/booking-notice'
import { sendPushToRolesAtLocation } from '@/lib/push'
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
const flowSubmit = () => inbound({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: '{}' } } })
const text = () => inbound({ type: 'text', text: { body: 'hi' } })

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

describe('FLOWACK.1 — a handled Flow class submission', () => {
  it('queues, stores the marker, acknowledges ONCE, and only THEN wakes the processor; Mia never runs', async () => {
    const order = []
    handleFlowCompletion.mockImplementationOnce(async () => { order.push('queued'); return { handled: true, kind: 'class', requestId: 'cbr1' } })
    sendFlowSubmissionReply.mockImplementationOnce(async () => { order.push(insertedInbound() ? 'ack(marker stored)' : 'ack(no marker)'); return { sent: true } })
    publishFlowClassBooking.mockImplementationOnce(async () => { order.push('publish') })
    const res = await POST(reqFor(flowSubmit()))
    expect(res.status).toBe(200)

    expect(handleFlowCompletion).toHaveBeenCalledTimes(1)
    expect(handleFlowCompletion).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-still', contact: expect.objectContaining({ id: 'ct1' }) }))
    // The ack goes before the processor can run, so a fast outcome ("the team is
    // confirming") can never arrive ahead of "we're booking your spot".
    expect(order).toEqual(['queued', 'ack(marker stored)', 'publish'])
    expect(publishFlowClassBooking).toHaveBeenCalledWith('cbr1')
    expect(insertedInbound().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ message_type: 'interactive', body: '[Booking submitted via WhatsApp Flow]' })

    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(sendFlowSubmissionReply).toHaveBeenCalledTimes(1)
    expect(sendFlowSubmissionReply).toHaveBeenCalledWith(db, {
      conversationId: 'conv-1', locationId: 'loc-still', completion: { handled: true, kind: 'class', requestId: 'cbr1' },
    })
    // The system answered the customer: no generic "new WhatsApp" staff push.
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('a failed acknowledgement never undoes the booking and never wakes Mia; staff get the push', async () => {
    handleFlowCompletion.mockResolvedValueOnce({ handled: true, kind: 'class' })
    sendFlowSubmissionReply.mockResolvedValueOnce({ sent: false, reason: 'send_error' })
    const res = await POST(reqFor(flowSubmit()))
    expect(res.status).toBe(200)
    expect(handleFlowCompletion).toHaveBeenCalledTimes(1)
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  it('an acknowledgement that throws is logged structurally, the processor is still woken, the webhook 200s', async () => {
    handleFlowCompletion.mockResolvedValueOnce({ handled: true, kind: 'class', requestId: 'cbr1' })
    sendFlowSubmissionReply.mockRejectedValueOnce(new Error('boom'))
    const res = await POST(reqFor(flowSubmit()))
    expect(res.status).toBe(200)
    expect(publishFlowClassBooking).toHaveBeenCalledWith('cbr1')
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('wa-webhook', expect.stringMatching(/acknowledg/), expect.objectContaining({ conversationId: 'conv-1' }))
  })

  it('the booking runs even when the inbound row could not be stored, is acknowledged, and the lost marker is logged', async () => {
    inboundInsert = { data: null, error: { message: 'insert failed' } }
    handleFlowCompletion.mockResolvedValueOnce({ handled: true, kind: 'class', requestId: 'cbr1' })
    await POST(reqFor(flowSubmit()))
    expect(handleFlowCompletion).toHaveBeenCalledTimes(1)
    expect(sendFlowSubmissionReply).toHaveBeenCalledTimes(1)
    expect(publishFlowClassBooking).toHaveBeenCalledWith('cbr1')
    expect(maybeAutoReply).not.toHaveBeenCalled()
    // Its outcome notices cannot find the thread: say so, structurally.
    expect(logError).toHaveBeenCalledWith('wa-webhook', expect.stringMatching(/marker/), expect.objectContaining({ requestId: 'cbr1', conversationId: 'conv-1' }))
  })

  it('a duplicate submission (the class is already asked for) is answered, never re-published', async () => {
    const completion = { handled: true, kind: 'class', duplicate: true, existingStatus: 'queued' }
    handleFlowCompletion.mockResolvedValueOnce(completion)
    await POST(reqFor(flowSubmit()))
    expect(sendFlowSubmissionReply).toHaveBeenCalledWith(db, { conversationId: 'conv-1', locationId: 'loc-still', completion })
    expect(publishFlowClassBooking).not.toHaveBeenCalled()
    expect(maybeAutoReply).not.toHaveBeenCalled()
  })
})

describe('FLOWACK.1 — a consult submission (booked on submit)', () => {
  it('gets the one reply (its confirmation) and no Mia turn', async () => {
    const completion = { handled: true, kind: 'consult', date: '2026-10-21', startTime: '10:00' }
    handleFlowCompletion.mockResolvedValueOnce(completion)
    await POST(reqFor(flowSubmit()))
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(sendFlowSubmissionReply).toHaveBeenCalledWith(db, { conversationId: 'conv-1', locationId: 'loc-still', completion })
  })
})

describe('FLOWACK.1 — a submission that was NOT handled keeps today\'s path', () => {
  it('handled:false → stored as "could not be processed" (never the queued marker), Mia (and staff) see it, logged', async () => {
    handleFlowCompletion.mockResolvedValueOnce({ handled: false })
    await POST(reqFor(flowSubmit()))
    expect(sendFlowSubmissionReply).not.toHaveBeenCalled()
    expect(publishFlowClassBooking).not.toHaveBeenCalled()
    expect(insertedInbound().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ message_type: 'interactive', body: '[Booking form submitted but could not be processed]' })
    expect(maybeAutoReply).toHaveBeenCalledTimes(1)
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ body: '[Booking form submitted but could not be processed]' }))
    expect(logError).toHaveBeenCalledWith('wa-webhook', expect.stringMatching(/not booked/), expect.objectContaining({ conversationId: 'conv-1' }))
  })

  it('a throw is the same: logged, Mia runs, no acknowledgement', async () => {
    handleFlowCompletion.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(reqFor(flowSubmit()))
    expect(res.status).toBe(200)
    expect(sendFlowSubmissionReply).not.toHaveBeenCalled()
    expect(maybeAutoReply).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalled()
  })
})

describe('FLOWACK.1 — ordinary messages are untouched', () => {
  it('a normal inbound text still gets Mia, no Flow handling, no acknowledgement', async () => {
    await POST(reqFor(text()))
    expect(maybeAutoReply).toHaveBeenCalledTimes(1)
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ messageType: 'text', body: 'hi' }))
    expect(handleFlowCompletion).not.toHaveBeenCalled()
    expect(sendFlowSubmissionReply).not.toHaveBeenCalled()
  })

  it('a session button reply (interactive, not a Flow) still gets Mia', async () => {
    await POST(reqFor(inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'opt_0', title: '7am' } } })))
    expect(maybeAutoReply).toHaveBeenCalledTimes(1)
    expect(handleFlowCompletion).not.toHaveBeenCalled()
    expect(sendFlowSubmissionReply).not.toHaveBeenCalled()
  })
})
