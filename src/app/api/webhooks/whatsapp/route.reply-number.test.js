// WAREPLYNUMBER.1 (C86) — the inbound webhook records WHICH number the
// customer wrote to, on whatsapp_conversations.whatsapp_number_id (mig 696),
// so replies into the thread go from it (getConversationReplyConfig).
//
// The stamp is its OWN update, never part of the conversation insert or the
// inbound stamp: if the column is missing (code deployed before 696 is
// applied) only the stamp is lost, logged, and the message, the thread and
// Mia's turn are untouched. It is written only when the receiving number
// belongs to the conversation's studio (a contact filed at another studio
// keeps that studio's thread, which replies from its own default).
// Harness copied from route.test.js (SAAS-2 routing contract).
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
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn() }))
vi.mock('@/lib/whatsapp-coexistence', () => ({
  parseEchoMessages: vi.fn(() => []),
  parseSyncContacts: vi.fn(() => []),
  parseHistoryMessages: vi.fn(() => []),
  nextHistorySyncState: vi.fn(),
}))
vi.mock('@/lib/whatsapp-coexistence-ingest', () => ({ syncContactMatchOnly: vi.fn(), ingestCoexistenceMessage: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { parseConsentKeyword, pickInboundContact } from '@/lib/whatsapp'
import { applyWhatsappConsentKeyword } from '@/lib/whatsapp-consent'
import { ingestCoexistenceMessage, syncContactMatchOnly } from '@/lib/whatsapp-coexistence-ingest'

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
    for (const m of ['select', 'eq', 'or', 'is', 'in', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
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
const STILLORGAN = { source: 'db', id: 'wn-1', locationId: 'loc-still', phoneNumberId: REGISTERED_PNI, token: 'tok' }

function reqFor(body) {
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } }
}

function envelope(value, field = 'messages') {
  return { entry: [{ changes: [{ field, value }] }] }
}

function inboundText(pniOrNull) {
  return envelope({
    metadata: pniOrNull ? { phone_number_id: pniOrNull } : {},
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.test1', from: '353871234567', timestamp: '1770000000', type: 'text', text: { body: 'hi' } }],
  })
}

function inboundTextBody(text) {
  return envelope({
    metadata: { phone_number_id: REGISTERED_PNI },
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.kw1', from: '353871234567', timestamp: '1770000000', type: 'text', text: { body: text } }],
  })
}

function statusUpdate(pniOrNull) {
  return envelope({
    metadata: pniOrNull ? { phone_number_id: pniOrNull } : {},
    statuses: [{ id: 'wamid.out1', status: 'delivered', timestamp: '1770000000' }],
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

const stamps = () => db.calls.filter((c) => c.table === 'whatsapp_conversations'
  && c.ops.some(([m, p]) => m === 'update' && p && 'whatsapp_number_id' in p))

describe('POST /api/webhooks/whatsapp — the receiving number is recorded on the thread (C86)', () => {
  it('a new thread is stamped with the receiving number, in its own update (the insert does not carry it)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).not.toHaveProperty('whatsapp_number_id')
    expect(stamps()).toHaveLength(1)
    expect(stamps()[0].ops).toEqual([['update', { whatsapp_number_id: 'wn-1' }], ['eq', 'id', 'conv-1']])
  })

  it('an existing thread is stamped too (the latest number written to wins)', async () => {
    db = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops, terminal) => (terminal === 'single' && !ops.some(([m]) => m === 'update')
        ? { data: { id: 'conv-old', contact_id: null, ctwa_clid: null }, error: null }
        : { data: null, error: null }),
      whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? { data: { id: 'msg-row-1' }, error: null } : { data: null, error: null }),
    })
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue({ ...STILLORGAN, id: 'wn-2' })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(stamps().map((c) => c.ops)).toEqual([[['update', { whatsapp_number_id: 'wn-2' }], ['eq', 'id', 'conv-old']]])
  })

  it('is written before Mia answers, so her reply resolves the number the customer wrote to', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    let stampedFirst = null
    maybeAutoReply.mockImplementationOnce(async () => { stampedFirst = stamps().length === 1; return { handled: false } })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(stampedFirst).toBe(true)
  })

  it('a contact filed at ANOTHER studio keeps that studio’s thread, and the thread is not stamped with this number', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-other' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-other' })
    expect(stamps()).toEqual([])
  })

  it('a failed stamp (e.g. 696 not applied yet) is logged and costs nothing else: message stored, Mia runs', async () => {
    db = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops) => {
        if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
        if (ops.some(([m, p]) => m === 'update' && p && 'whatsapp_number_id' in p)) {
          return { data: null, error: { message: "Could not find the 'whatsapp_number_id' column of 'whatsapp_conversations' in the schema cache" } }
        }
        return { data: null, error: null }
      },
      whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? { data: { id: 'msg-row-1' }, error: null } : { data: null, error: null }),
    })
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    expect(db.calls.some((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))).toBe(true)
    expect(maybeAutoReply).toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(
      '[wa-webhook] receiving-number stamp failed for conversation conv-1 (replies go from the studio default):',
      "Could not find the 'whatsapp_number_id' column of 'whatsapp_conversations' in the schema cache",
    )
  })
})
