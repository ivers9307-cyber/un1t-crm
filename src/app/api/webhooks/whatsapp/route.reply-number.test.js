// WAREPLYNUMBER.1 (C86) — the inbound webhook records WHICH number the
// customer wrote to, on whatsapp_conversations.whatsapp_number_id (mig 696),
// so replies into the thread go from it (getConversationReplyConfig).
//
// The stamp is its OWN update, never part of the conversation insert or the
// inbound stamp: if the column is missing (code deployed before 696 is
// applied) only the stamp is lost, logged, and the message, the thread and
// Mia's turn are untouched. It is written when the receiving number
// belongs to the conversation's studio, or the conversation's studio has no
// number of its own (WAHOMESTUDIO.1); a contact filed at another studio WITH a
// number keeps that studio's thread, which replies from its own default.
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
  // the contact's own studio's number; null = no number there (WAHOMESTUDIO.1: decides the stamp only)
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
// NOTE (WA-COEX.7): this EMPTY set is why the unreachable account_update branch went
// unnoticed — with the real set the field is claimed by the number-event branch. Tests
// that need the real dispatch use vi.importActual (route.account-update.test.js).
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
import { resolveWhatsAppNumberByPhoneNumberId, getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { pickInboundContact } from '@/lib/whatsapp'
import { handleFlowCompletion } from '@/lib/whatsapp-flow/completion.js'
import { recordCtwaTouch } from '@/lib/meta-capi'

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

function inboundFlowReply(pni) {
  return envelope({
    metadata: { phone_number_id: pni },
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.flow1', from: '353871234567', timestamp: '1770000000', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } } }],
  })
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

  it('a contact filed at ANOTHER studio that has its own number keeps that studio’s thread, and the thread is not stamped with this number', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-other' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce({ source: 'db', id: 'wn-other', locationId: 'loc-other', phoneNumberId: '555', token: 'tok2' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith('loc-other')
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-other' })
    expect(stamps()).toEqual([])
  })

  // WAHOMESTUDIO.1 (R2/R3) — the thread lives at the contact's own studio even
  // when it has no number; replies go through the receiving number stamped on
  // it (a same-organisation sibling's, getConversationNumberConfig R4).
  it('a contact filed at a studio with NO WhatsApp number gets the thread AT that studio, stamped with the receiving number', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(null)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const lookup = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'select'))
    expect(lookup.ops).toContainEqual(['eq', 'location_id', 'loc-hatch'])
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch', contact_id: 'contact-9' })
    const msgInsert = db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))
    expect(msgInsert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch' })
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch' }))
    expect(stamps().map((c) => c.ops)).toEqual([[['update', { whatsapp_number_id: 'wn-1' }], ['eq', 'id', 'conv-1']]])
  })

  it('a failed number lookup for the contact’s studio still files there and stamps (the stamp is inert where a number exists), logged', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    getLocationWhatsAppNumberConfig.mockRejectedValueOnce(new Error('Failed to load WhatsApp config for location loc-hatch: boom'))
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch' })
    expect(stamps()).toHaveLength(1)
    expect(errSpy).toHaveBeenCalledWith(
      '[wa-webhook] WhatsApp number lookup for location loc-hatch failed (thread stamped with the receiving number):',
      'Failed to load WhatsApp config for location loc-hatch: boom',
    )
  })

  it('an unknown sender still files at the receiving studio, stamped', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still', contact_id: null })
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })

  // WAHOMESTUDIO.1 — Flows, ads and Glofox belong to the studio whose number
  // the customer used. A thread filed at a number-less home studio still acts
  // for the receiving number's studio.
  it('a number-less-home contact completing a Flow: the completion runs for the receiving number’s studio', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(null)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundFlowReply(REGISTERED_PNI)))
    expect(handleFlowCompletion).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-still' }))
    const insert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(insert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch' })
  })

  it('a number-less-home contact’s CTWA referral is recorded for the receiving number’s studio', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(null)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundCtwa(REGISTERED_PNI)))
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ ctwaClid: 'clid-1', locationId: 'loc-still' }))
  })

  it('control: a contact at a studio WITH its own number keeps that studio for the Flow completion and the CTWA touch', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-other' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce({ source: 'db', id: 'wn-other', locationId: 'loc-other', phoneNumberId: '555', token: 'tok2' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundFlowReply(REGISTERED_PNI)))
    expect(handleFlowCompletion).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-other' }))
    vi.clearAllMocks()
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-other' })
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce({ source: 'db', id: 'wn-other', locationId: 'loc-other', phoneNumberId: '555', token: 'tok2' })
    await POST(reqFor(inboundCtwa(REGISTERED_PNI)))
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-other' }))
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

// WAHOMESTUDIO.1 (F1) — staff moved an unknown sender's thread from the
// receiving studio to a number-less sibling (Move to studio). The next inbound
// must land in THAT thread, not open a fresh one back at the receiving studio.
describe('POST /api/webhooks/whatsapp — a thread moved to a number-less studio stays put (F1)', () => {
  const isMovedLookup = (ops) => ops.some(([m]) => m === 'select') && ops.some(([m, col]) => m === 'eq' && col === 'whatsapp_number_id')
  const HATCH_THREAD = { id: 'conv-hatch', contact_id: null, ctwa_clid: null, location_id: 'loc-hatch' }

  function movedDb({ moved = { data: [HATCH_THREAD], error: null }, numbers = { data: [], error: null } } = {}) {
    return makeDb({
      contacts: { data: [], error: null },
      locations: (ops, terminal) => (terminal === 'maybeSingle'
        ? { data: { id: 'loc-still', organization_id: 'org-1' }, error: null }
        : { data: [{ id: 'loc-hatch' }, { id: 'loc-other' }], error: null }),
      whatsapp_conversations: (ops, terminal) => {
        if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-new' }, error: null }
        if (isMovedLookup(ops)) return moved
        if (terminal === 'single') return { data: null, error: null }
        return { data: null, error: null }
      },
      whatsapp_numbers: numbers,
      whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? { data: { id: 'msg-row-1' }, error: null } : { data: null, error: null }),
    })
  }
  const convInserts = () => db.calls.filter((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
  const msgInsert = () => db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))

  it('an unknown sender whose thread was moved to Hatch (stamped with this number) is filed into that Hatch thread, no new thread', async () => {
    db = movedDb()
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    const lookup = db.calls.find((c) => c.table === 'whatsapp_conversations' && isMovedLookup(c.ops))
    expect(lookup.ops).toContainEqual(['eq', 'wa_phone', '353871234567'])
    expect(lookup.ops).toContainEqual(['eq', 'whatsapp_number_id', 'wn-1'])
    expect(lookup.ops).toContainEqual(['in', 'location_id', ['loc-still', 'loc-hatch', 'loc-other']])
    const numbersRead = db.calls.find((c) => c.table === 'whatsapp_numbers')
    expect(numbersRead.ops).toContainEqual(['in', 'location_id', ['loc-hatch']])
    expect(numbersRead.ops).toContainEqual(['eq', 'is_active', true])
    expect(convInserts()).toEqual([])
    expect(msgInsert().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ conversation_id: 'conv-hatch', location_id: 'loc-hatch' })
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ conversationId: 'conv-hatch', locationId: 'loc-hatch' }))
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })

  it('Flows still act for the receiving studio when the thread was moved to a number-less studio', async () => {
    db = movedDb()
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundFlowReply(REGISTERED_PNI)))
    expect(handleFlowCompletion).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-still' }))
    expect(convInserts()).toEqual([])
  })

  it('a stamped thread at a studio that HAS its own number is ignored: a new thread opens at the receiving studio', async () => {
    db = movedDb({
      moved: { data: [{ ...HATCH_THREAD, id: 'conv-other', location_id: 'loc-other' }], error: null },
      numbers: { data: [{ location_id: 'loc-other' }], error: null },
    })
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(convInserts()).toHaveLength(1)
    expect(convInserts()[0].ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still' })
    expect(msgInsert().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ conversation_id: 'conv-new', location_id: 'loc-still' })
  })

  it('two candidate threads (ambiguous) → a new thread opens at the receiving studio', async () => {
    db = movedDb({ moved: { data: [HATCH_THREAD, { ...HATCH_THREAD, id: 'conv-hatch-2', location_id: 'loc-other' }], error: null } })
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(convInserts()).toHaveLength(1)
    expect(convInserts()[0].ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still' })
  })

  it('a failed moved-thread read is logged and the message still lands in a new thread at the receiving studio', async () => {
    db = movedDb({ moved: { data: null, error: { message: 'boom' } } })
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    expect(convInserts()).toHaveLength(1)
    expect(convInserts()[0].ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still' })
    expect(msgInsert()).toBeTruthy()
    expect(errSpy).toHaveBeenCalledWith(
      '[wa-webhook] moved-thread lookup failed (a new thread opens at loc-still):',
      'boom',
    )
  })
})
