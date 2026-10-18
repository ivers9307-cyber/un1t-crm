// WASTUDIOPICK.1 — the inbound webhook decides an unknown sender's studio
// (resolveNewSenderStudio) after the message is stored and before consent, Mia,
// the push and the greeting. 'asked' keeps Mia and the greeting quiet (the
// question is outstanding); 'decided' moves what runs after it to the new
// studio and thread; a throwing resolver is logged and the message carries on.
// Harness copied from route.reply-number.test.js.
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
// Keep the REAL classifyInboundOwner — the route + classifier pair is the
// contract under test. Only the DB lookup is mocked.
vi.mock('@/lib/whatsapp-config', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))
// WAORGNUMBER.5 — the inbound router's answer; default: a new thread at the number's home.
vi.mock('@/lib/whatsapp-inbound-route', () => ({
  routeInboundThread: vi.fn(async (_db, { numberHomeLocationId }) => ({ locationId: numberHomeLocationId, conversation: null, by: 'number_home', switchedOn: true })),
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
vi.mock('@/lib/wa-studio-pick/resolve', () => ({
  resolveNewSenderStudio: vi.fn(async (db, ctx) => ({ action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId })),
}))
vi.mock('@/lib/whatsapp-template-events', () => ({ applyTemplateEvent: vi.fn(async () => ({ template: null, notify: null })) }))
// NOTE (WA-COEX.7): this EMPTY set is why the unreachable account_update branch went
// unnoticed — with the real set the field is claimed by the number-event branch. Tests
// that need the real dispatch use vi.importActual (route.account-update.test.js).
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

import { POST } from './route'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { recordCtwaTouch } from '@/lib/meta-capi'
import { resolveNewSenderStudio } from '@/lib/wa-studio-pick/resolve'
import { routeInboundThread } from '@/lib/whatsapp-inbound-route'
import { maybeSendWelcomeGreeting } from '@/lib/agent/welcome-greeting'

// Recording fake supabase client: chainable builder, thenable (matches
// supabase-js), with per-table response handlers. Every terminal call is
// recorded so tests can assert "zero writes" for dropped traffic.
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
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.single = async () => finish('single')
    b.maybeSingle = async () => finish('maybeSingle')
    b.then = (onFulfilled, onRejected) => Promise.resolve(finish('await')).then(onFulfilled, onRejected)
    return b
  })
  const db = { from, rpc: vi.fn(async () => ({ data: null, error: null })), calls }
  db.writes = () => calls.filter((c) => c.ops.some(([m]) => ['insert', 'update', 'upsert', 'delete'].includes(m)))
  return db
}

const REGISTERED_PNI = '1233588839827698'
// The resolver's config shape for an active whatsapp_numbers row.
// WAORGNUMBER.1 — the resolver's config names the number's home studio (classifyInboundOwner routes on it).
const STILLORGAN = { source: 'db', id: 'wn-1', locationId: 'loc-still', homeLocationId: 'loc-still', phoneNumberId: REGISTERED_PNI, token: 'tok' }

function reqFor(body) {
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } }
}

function envelope(value, field = 'messages') {
  return { entry: [{ changes: [{ field, value }] }] }
}

function inboundCtwa(pni) {
  return envelope({
    metadata: { phone_number_id: pni },
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.ctwa1', from: '353871234567', timestamp: '1770000000', type: 'text', text: { body: 'hi' }, referral: { ctwa_clid: 'clid-1' } }],
  })
}

function inboundText(pniOrNull) {
  return envelope({
    metadata: pniOrNull ? { phone_number_id: pniOrNull } : {},
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.test1', from: '353871234567', timestamp: '1770000000', type: 'text', text: { body: 'hi' } }],
  })
}

let errSpy
let db

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = makeDb({
    contacts: { data: [], error: null },
    whatsapp_conversations: (ops, terminal) => {
      if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
      if (terminal === 'single') return { data: null, error: null }
      return { data: null, error: null }
    },
    whatsapp_messages: (ops) => {
      if (ops.some(([m]) => m === 'insert')) return { data: { id: 'msg-row-1' }, error: null }
      return { data: null, error: null }
    },
  })
  createServerClient.mockReturnValue(db)
})

afterEach(() => {
  vi.restoreAllMocks()
})


const resolverCalls = () => resolveNewSenderStudio.mock.calls

function inboundRequestWelcome(pni) {
  return envelope({
    metadata: { phone_number_id: pni },
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.w', from: '353871234567', timestamp: '1770000000', type: 'request_welcome' }],
  })
}

describe('POST /api/webhooks/whatsapp — a new sender\u2019s studio is decided before Mia (WASTUDIOPICK.1)', () => {
  it('an unknown sender\u2019s message calls the resolver with the thread, the receiving studio and the raw message', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(resolveNewSenderStudio).toHaveBeenCalledWith(db, expect.objectContaining({
      conversationId: 'conv-1', threadLocationId: 'loc-still', receivingLocationId: 'loc-still', receivingNumberId: STILLORGAN.id, contactId: null,
      resolution: null, messageType: 'text', body: 'hi', senderPhone: '353871234567',
      message: expect.objectContaining({ id: 'wamid.test1' }),
    }))
  })

  it('is called after the inbound message is stored, and not at all when that insert failed', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    let storedFirst = null
    resolveNewSenderStudio.mockImplementationOnce(async (_db, ctx) => {
      storedFirst = db.calls.some((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))
      return { action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
    })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(storedFirst).toBe(true)

    vi.clearAllMocks()
    db = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops) => (ops.some(([m]) => m === 'insert') ? { data: { id: 'conv-1' }, error: null } : { data: null, error: null }),
      whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? { data: null, error: { message: 'insert boom' } } : { data: null, error: null }),
    })
    createServerClient.mockReturnValue(db)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(resolverCalls()).toHaveLength(0)
    expect(maybeAutoReply).not.toHaveBeenCalled()
  })

  it('asked \u2192 Mia is NOT called, the push still goes', async () => {
    // the push re-reads the thread (select names assigned_to); give it a row
    db = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops, terminal) => {
        if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
        if (terminal === 'single' && ops.some(([m, c]) => m === 'select' && String(c).includes('assigned_to'))) {
          return { data: { assigned_to: null, location_id: 'loc-still', wa_profile_name: 'Test Sender', contacts: null }, error: null }
        }
        return { data: null, error: null }
      },
      whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? { data: { id: 'msg-row-1' }, error: null } : { data: null, error: null }),
    })
    createServerClient.mockReturnValue(db)
    resolveNewSenderStudio.mockResolvedValueOnce({ action: 'asked', locationId: 'loc-still', conversationId: 'conv-1' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).toHaveBeenCalledWith('loc-still', expect.anything(), expect.objectContaining({ body: 'hi' }))
  })

  it('decided \u2192 Mia runs at the NEW studio and conversation', async () => {
    resolveNewSenderStudio.mockResolvedValueOnce({ action: 'decided', locationId: 'loc-hatch', conversationId: 'conv-9' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch', conversationId: 'conv-9' }))
  })

  it('decided \u2192 the CTWA touch already ran at the routed studio, before the picker moved the thread (WAORGNUMBER.5)', async () => {
    resolveNewSenderStudio.mockResolvedValueOnce({ action: 'decided', locationId: 'loc-hatch', conversationId: 'conv-9' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundCtwa(REGISTERED_PNI)))
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ ctwaClid: 'clid-1', locationId: 'loc-still' }))
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch' }))
  })

  it('unresolved \u2192 Mia runs at the studio the resolver reports (the thread stays)', async () => {
    resolveNewSenderStudio.mockResolvedValueOnce({ action: 'unresolved', locationId: 'loc-still', conversationId: 'conv-1' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-still', conversationId: 'conv-1' }))
  })

  it('an existing thread\u2019s studio_resolution is passed through (a staff-moved thread carries decided/staff)', async () => {
    const resolution = { status: 'decided', by: 'staff' }
    routeInboundThread.mockResolvedValueOnce({ locationId: 'loc-still', by: 'number_home', switchedOn: true, conversation: { id: 'conv-old', location_id: 'loc-still', contact_id: null, ctwa_clid: null, studio_resolution: resolution } })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(resolveNewSenderStudio).toHaveBeenCalledWith(db, expect.objectContaining({
      conversationId: 'conv-old', threadLocationId: 'loc-still', resolution,
    }))
  })

  it('a thread staff moved to a number-less studio carries its studio_resolution to the resolver too (numberless_home)', async () => {
    const resolution = { status: 'decided', by: 'staff' }
    routeInboundThread.mockResolvedValueOnce({ locationId: 'loc-hatch', by: 'numberless_home', switchedOn: false, conversation: { id: 'conv-hatch', location_id: 'loc-hatch', contact_id: null, ctwa_clid: null, studio_resolution: resolution } })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(resolveNewSenderStudio).toHaveBeenCalledWith(db, expect.objectContaining({
      conversationId: 'conv-hatch', threadLocationId: 'loc-hatch', receivingLocationId: 'loc-still', resolution,
    }))
  })

  it('request_welcome + asked \u2192 no greeting; + skip \u2192 greeting as today', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    resolveNewSenderStudio.mockResolvedValueOnce({ action: 'asked', locationId: 'loc-still', conversationId: 'conv-1' })
    await POST(reqFor(inboundRequestWelcome(REGISTERED_PNI)))
    expect(resolveNewSenderStudio).toHaveBeenCalledWith(db, expect.objectContaining({ messageType: 'request_welcome' }))
    expect(maybeSendWelcomeGreeting).not.toHaveBeenCalled()

    vi.clearAllMocks()
    await POST(reqFor(inboundRequestWelcome(REGISTERED_PNI)))
    expect(maybeSendWelcomeGreeting).toHaveBeenCalledTimes(1)
    expect(maybeSendWelcomeGreeting).toHaveBeenCalledWith(db, expect.objectContaining({ conversationId: 'conv-1', locationId: 'loc-still' }))
    expect(maybeAutoReply).not.toHaveBeenCalled()
  })

  it('a resolver that throws is logged and the message carries on (200, Mia runs)', async () => {
    resolveNewSenderStudio.mockRejectedValueOnce(new Error('boom'))
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-still', conversationId: 'conv-1' }))
    expect(errSpy).toHaveBeenCalledWith('[wa-webhook] studio picker failed (carrying on):', 'boom')
  })
})
