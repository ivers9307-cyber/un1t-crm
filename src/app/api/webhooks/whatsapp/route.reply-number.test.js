// WAREPLYNUMBER.1 (C86) — the inbound webhook records WHICH number the
// customer wrote to, on whatsapp_conversations.whatsapp_number_id (mig 696),
// so replies into the thread go from it (getConversationReplyConfig).
//
// The stamp is its OWN update, never part of the conversation insert or the
// inbound stamp: if the column is missing (code deployed before 696 is
// applied) only the stamp is lost, logged, and the message, the thread and
// Mia's turn are untouched. WAORGNUMBER.5: the studio is decided by
// routeInboundThread (mocked here; its rules are whatsapp-inbound-route.test.js,
// end to end route.inbound-route.test.js), and the stamp is written when the
// receiving number is switched on at the winning studio, or the thread is at a
// number-less home studio (transitional WAHOMESTUDIO.1, 'numberless_home').
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
// WAORGNUMBER.5 — the router's answer; default: a new thread at the number's home, switched on.
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
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'
import { routeInboundThread } from '@/lib/whatsapp-inbound-route'
import { applyWhatsappConsentKeyword } from '@/lib/whatsapp-consent'
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { pickInboundContact, parseConsentKeyword } from '@/lib/whatsapp'
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
const STILLORGAN = { source: 'db', id: 'wn-1', locationId: 'loc-still', homeLocationId: 'loc-still', organizationId: 'org-1', phoneNumberId: REGISTERED_PNI, token: 'tok' }

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
  pickInboundContact.mockReset().mockReturnValue(null)
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
const convInserts = () => db.calls.filter((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
const msgInsert = () => db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))
const routed = (r) => routeInboundThread.mockResolvedValueOnce({ conversation: null, switchedOn: true, ...r })

describe('POST /api/webhooks/whatsapp — the inbound router decides the studio (WAORGNUMBER.5)', () => {
  it('asks the router with the receiving number, its home, its organisation, the sender, the contact, the quoted id and the referral', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const env = inboundCtwa(REGISTERED_PNI)
    env.entry[0].changes[0].value.messages[0].context = { id: 'wamid.quoted' }
    await POST(reqFor(env))
    expect(routeInboundThread).toHaveBeenCalledWith(db, {
      numberId: 'wn-1',
      numberHomeLocationId: 'loc-still',
      organizationId: 'org-1',
      waPhone: '353871234567',
      bsuid: null,
      contact: { id: 'contact-9', location_id: 'loc-hatch' },
      contextMessageId: 'wamid.quoted',
      referral: { ctwa_clid: 'clid-1' },
    })
  })

  it('files the message, Mia, the Flow completion and the CTWA touch at the routed studio', async () => {
    pickInboundContact.mockReturnValue({ id: 'contact-9', location_id: 'loc-still' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-hatch', by: 'recent', conversation: { id: 'conv-hatch', location_id: 'loc-hatch', contact_id: 'contact-9', ctwa_clid: null, studio_resolution: null } })
    await POST(reqFor(inboundFlowReply(REGISTERED_PNI)))
    expect(convInserts()).toEqual([])
    expect(msgInsert().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ conversation_id: 'conv-hatch', location_id: 'loc-hatch' })
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ conversationId: 'conv-hatch', locationId: 'loc-hatch' }))
    expect(handleFlowCompletion).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch' }))

    vi.clearAllMocks()
    routed({ locationId: 'loc-hatch', by: 'ad' })
    await POST(reqFor(inboundCtwa(REGISTERED_PNI)))
    expect(convInserts().at(-1).ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch', ctwa_clid: 'clid-1' })
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ ctwaClid: 'clid-1', locationId: 'loc-hatch' }))
  })

  it('consent keyword acts at the routed studio', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    parseConsentKeyword.mockReturnValueOnce('stop')
    applyWhatsappConsentKeyword.mockResolvedValueOnce({ applied: true })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-still', by: 'recent', conversation: { id: 'conv-still', location_id: 'loc-still', contact_id: 'contact-9', ctwa_clid: null, studio_resolution: null } })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(applyWhatsappConsentKeyword).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-still', conversationId: 'conv-still' }))
  })

  it('an existing thread the router found with no contact is linked, and its CTWA click is credited to the routed studio', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-still' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-hatch', by: 'recent', conversation: { id: 'conv-hatch', location_id: 'loc-hatch', contact_id: null, ctwa_clid: 'clid-old', studio_resolution: null } })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const linkWrite = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m, p]) => m === 'update' && p?.contact_id === 'contact-9'))
    expect(linkWrite.ops).toContainEqual(['eq', 'id', 'conv-hatch'])
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ ctwaClid: 'clid-old', conversationId: null, locationId: 'loc-hatch' }))
  })
})

describe('POST /api/webhooks/whatsapp — the receiving number is recorded on the thread (C86)', () => {
  it('a new thread is stamped with the receiving number, in its own update (the insert does not carry it)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    const insert = convInserts()[0]
    expect(insert.ops.find(([m]) => m === 'insert')[1]).not.toHaveProperty('whatsapp_number_id')
    expect(stamps()).toHaveLength(1)
    expect(stamps()[0].ops).toEqual([['update', { whatsapp_number_id: 'wn-1' }], ['eq', 'id', 'conv-1']])
  })

  it('an existing thread is stamped too (the latest number written to wins, so a stamp switched off there is replaced)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue({ ...STILLORGAN, id: 'wn-2' })
    routed({ locationId: 'loc-still', by: 'recent', conversation: { id: 'conv-old', location_id: 'loc-still', contact_id: null, ctwa_clid: null, studio_resolution: null } })
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

  it('a winner the number is NOT switched on at keeps its own stamp', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-other', by: 'number_home', switchedOn: false })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(convInserts()[0].ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-other' })
    expect(stamps()).toEqual([])
  })

  // WAHOMESTUDIO.1 (R2/R3), transitional until WAORGNUMBER.6 — while Hatch has
  // nothing switched on, its threads land at Hatch and reply through the
  // receiving number stamped on them.
  it('numberless_home: the thread is AT the number-less home studio and stamped with the receiving number', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-hatch', by: 'numberless_home', switchedOn: false })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(convInserts()[0].ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch', contact_id: 'contact-9' })
    expect(msgInsert().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch' })
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch' }))
    expect(stamps().map((c) => c.ops)).toEqual([[['update', { whatsapp_number_id: 'wn-1' }], ['eq', 'id', 'conv-1']]])
  })

  it('numberless_home (a thread staff moved there): the message joins it and nothing new opens', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-hatch', by: 'numberless_home', switchedOn: false, conversation: { id: 'conv-hatch', location_id: 'loc-hatch', contact_id: null, ctwa_clid: null, studio_resolution: null } })
    await POST(reqFor(inboundFlowReply(REGISTERED_PNI)))
    expect(convInserts()).toEqual([])
    expect(msgInsert().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ conversation_id: 'conv-hatch', location_id: 'loc-hatch' })
    // The Flow was minted by a send through the receiving number, so it completes at that number's studio.
    expect(handleFlowCompletion).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-still' }))
  })

  it('numberless_home: the CTWA Lead stays with the receiving number’s studio (a number-less studio has no token to send it)', async () => {
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    routed({ locationId: 'loc-hatch', by: 'numberless_home', switchedOn: false })
    await POST(reqFor(inboundCtwa(REGISTERED_PNI)))
    expect(convInserts()[0].ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-hatch', ctwa_clid: 'clid-1' })
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ ctwaClid: 'clid-1', locationId: 'loc-still' }))

    vi.clearAllMocks()
    pickInboundContact.mockReturnValueOnce({ id: 'contact-9', location_id: 'loc-hatch' })
    routed({ locationId: 'loc-hatch', by: 'numberless_home', switchedOn: false, conversation: { id: 'conv-hatch', location_id: 'loc-hatch', contact_id: null, ctwa_clid: 'clid-old', studio_resolution: null } })
    await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(recordCtwaTouch).toHaveBeenCalledWith(db, expect.objectContaining({ ctwaClid: 'clid-old', conversationId: null, locationId: 'loc-still' }))
  })

  it('a thread insert that loses the unique race re-reads the thread, so the message is not lost', async () => {
    db = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops, terminal) => {
        if (ops.some(([m]) => m === 'insert')) return { data: null, error: { message: 'duplicate key value violates unique constraint' } }
        if (terminal === 'maybeSingle') return { data: { id: 'conv-existing' }, error: null }
        return { data: null, error: null }
      },
      whatsapp_messages: (ops) => (ops.some(([m]) => m === 'insert') ? { data: { id: 'msg-row-1' }, error: null } : { data: null, error: null }),
    })
    createServerClient.mockReturnValue(db)
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)
    const reread = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.terminal === 'maybeSingle')
    expect(reread.ops).toEqual(expect.arrayContaining([['eq', 'location_id', 'loc-still'], ['eq', 'wa_phone', '353871234567']]))
    expect(msgInsert().ops.find(([m]) => m === 'insert')[1]).toMatchObject({ conversation_id: 'conv-existing', location_id: 'loc-still' })
    expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ conversationId: 'conv-existing' }))
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
