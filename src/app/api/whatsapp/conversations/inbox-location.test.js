// INBOXLOC.1 (C37) — every WhatsApp thread route judges the caller's WhatsApp
// permission at the CONVERSATION's studio (the contact's, for /start), never
// at the ACTIVE studio.
//
// The defect: each handler opened with requireInboxPermission(user, 'wa'),
// which resolves `whatsapp` at the active studio (the phone's
// x-active-location header). The phone opens threads from a contact at any of
// the caller's studios, so a thread at studio B was refused for a caller who
// holds WhatsApp at B but not at their active studio A, and served to a
// caller who holds it at A but not at B.
//
// INBOXWEBONLY3.1 (C119, Richard 30 Sep): the routes the phone calls accept
// web OR mobile `whatsapp` there; the three only the web calls (/agent,
// /add-contact, /start) accept the WEB key only, judged at the same studio.
//
// The real permission helpers run here (src/lib/auth.js, src/lib/permissions.js):
// only getCurrentUser, the service-role client and the outbound WhatsApp
// senders are stubbed. The caller belongs to both studios; the conversation is
// at B. "Passes the gate" means the handler went on to its own work: any
// answer but 401/403/404 (a stub may make that work fail later, which is fine).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.test' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.test' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.test' })),
  sendFlowMessage: vi.fn(async () => ({ messageId: 'wamid.test' })),
  sendReaction: vi.fn(async () => ({ messageId: 'wamid.test' })),
  setWhatsAppUserBlockState: vi.fn(async () => ({})),
  isWindowOpen: vi.fn(() => true),
  headerComponentFor: vi.fn(() => null),
}))
vi.mock('@/lib/whatsapp-carousel-send', () => ({
  sendCardSetToConversation: vi.fn(async () => ({ ok: true })),
}))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import * as thread from './[id]/route.js'
import * as send from './[id]/send/route.js'
import * as sendFlow from './[id]/send-flow/route.js'
import * as sendCarousel from './[id]/send-carousel/route.js'
import * as react from './[id]/react/route.js'
import * as block from './[id]/block/route.js'
import * as agent from './[id]/agent/route.js'
import * as addContact from './[id]/add-contact/route.js'
import * as start from './start/route.js'

const A = '00000000-0000-4000-8000-00000000000a' // the caller's ACTIVE studio
const B = '00000000-0000-4000-8000-00000000000b' // the conversation's studio
const CONV = '00000000-0000-4000-8000-0000000000c1'
const CONTACT = '00000000-0000-4000-8000-0000000000c2'
const SET = '00000000-0000-4000-8000-0000000000c3'

const OFF = { whatsapp: false, mobile: { whatsapp: false } }
const ON = { whatsapp: true, mobile: { whatsapp: true } }
const MOBILE_ONLY = { whatsapp: false, mobile: { whatsapp: true } }
const WEB_ONLY = { whatsapp: true, mobile: { whatsapp: false } }

function caller(atA, atB) {
  return {
    id: 'u1',
    role: 'staff',
    activeLocation: { id: A, features: {} },
    activeAssignment: { role: 'staff', permissions: atA },
    locations: [{ id: A, role: 'staff', features: {} }, { id: B, role: 'staff', features: {} }],
    assignmentsByLocation: { [A]: { role: 'staff', permissions: atA }, [B]: { role: 'staff', permissions: atB } },
    user: { id: 'u1' },
  }
}

// A chainable stand-in for the service-role client: every builder method
// returns the builder, .single()/.maybeSingle() answer with the table's row,
// and awaiting the builder answers with an empty list.
const ROWS = {
  whatsapp_conversations: {
    id: CONV, location_id: B, contact_id: CONTACT, wa_phone: '+353800000000',
    window_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    agent_handed_off_at: null, is_blocked: false,
    contacts: { id: CONTACT, name: 'Test', wa_phone: '+353800000000', location_id: B },
  },
  contacts: { id: CONTACT, phone: '+353800000000', wa_phone: '+353800000000', location_id: B },
  locations: { settings: { wa_card_sets: [{ id: SET, cards: [] }] } },
  whatsapp_messages: { id: 'm1', wa_message_id: 'wamid.in', location_id: B, conversation_id: CONV },
}

function builder(table) {
  const one = ROWS[table] ?? null
  const single = () => Promise.resolve({ data: one, error: one ? null : { message: 'no rows' } })
  const b = new Proxy(function stub() {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej)
      if (prop === 'single' || prop === 'maybeSingle') return single
      return () => b
    },
    apply() { return b },
  })
  return b
}

const db = { from: (t) => builder(t), rpc: () => builder('rpc') }

const params = { params: Promise.resolve({ id: CONV }) }
const req = (method, body) => new Request('http://localhost/api/x', {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

// The routes the phone calls: web OR mobile `whatsapp` at the thread's studio.
const PHONE_HANDLERS = [
  ['GET /conversations/[id]', () => thread.GET(req('GET'), params)],
  ['PATCH /conversations/[id]', () => thread.PATCH(req('PATCH', { resolved: true }), params)],
  ['POST /send', () => send.POST(req('POST', { type: 'text', text: 'hi' }), params)],
  ['POST /send-flow', () => sendFlow.POST(req('POST'), params)],
  ['POST /send-carousel', () => sendCarousel.POST(req('POST', { card_set_id: SET }), params)],
  ['POST /react', () => react.POST(req('POST', { message_id: 'wamid.in', emoji: '👍' }), params)],
  ['POST /block', () => block.POST(req('POST', { action: 'block' }), params)],
]

// INBOXWEBONLY3.1 (C119) — the routes only the web calls (Richard, 30 Sep):
// the WEB `whatsapp` key at the thread's (the contact's, for /start) studio.
const WEB_ONLY_HANDLERS = [
  ['PATCH /agent', () => agent.PATCH(req('PATCH', { active: true }), params)],
  ['POST /add-contact', () => addContact.POST(req('POST', { name: 'Test' }), params)],
  ['POST /start', () => start.POST(req('POST', { contact_id: CONTACT }))],
]

const HANDLERS = [...PHONE_HANDLERS, ...WEB_ONLY_HANDLERS]

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(db)
})

describe('WhatsApp thread routes judge at the conversation\'s studio (INBOXLOC.1)', () => {
  it.each(HANDLERS)('%s: WhatsApp off at the active studio, on at the thread\'s: passes the gate', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(OFF, ON))
    const res = await call()
    expect([401, 403, 404]).not.toContain(res.status)
  })

  it.each(PHONE_HANDLERS)('%s: the mobile toggle at the thread\'s studio is enough (the phone calls these)', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(OFF, MOBILE_ONLY))
    const res = await call()
    expect([401, 403, 404]).not.toContain(res.status)
  })

  it.each(HANDLERS)('%s: WhatsApp on at the active studio, off at the thread\'s: 403', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(ON, OFF))
    const res = await call()
    expect(res.status).toBe(403)
  })

  it.each(HANDLERS)('%s: WhatsApp off everywhere: 403 before any read', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(OFF, OFF))
    const from = vi.spyOn(db, 'from')
    const res = await call()
    expect(res.status).toBe(403)
    expect(from).not.toHaveBeenCalled()
    from.mockRestore()
  })
})

describe('the web-only thread actions keep the WEB whatsapp key (INBOXWEBONLY3.1)', () => {
  it.each(WEB_ONLY_HANDLERS)('%s: the mobile toggle alone at the thread\'s studio: 403 after the row is read', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(ON, MOBILE_ONLY))
    const from = vi.spyOn(db, 'from')
    const res = await call()
    expect(res.status).toBe(403)
    // judged at the record's studio, so the row was read first
    expect(from).toHaveBeenCalled()
    from.mockRestore()
  })

  it.each(WEB_ONLY_HANDLERS)('%s: the web key at the thread\'s studio (mobile off): passes the gate', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(OFF, WEB_ONLY))
    const res = await call()
    expect([401, 403, 404]).not.toContain(res.status)
  })

  it.each(WEB_ONLY_HANDLERS)('%s: the mobile toggle alone everywhere: 403 before any read', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(MOBILE_ONLY, MOBILE_ONLY))
    const from = vi.spyOn(db, 'from')
    const res = await call()
    expect(res.status).toBe(403)
    expect(from).not.toHaveBeenCalled()
    from.mockRestore()
  })

  it.each(PHONE_HANDLERS)('%s: the mobile toggle alone everywhere still passes (the phone calls these)', async (_name, call) => {
    getCurrentUser.mockResolvedValue(caller(MOBILE_ONLY, MOBILE_ONLY))
    const res = await call()
    expect([401, 403, 404]).not.toContain(res.status)
  })

  it.each(WEB_ONLY_HANDLERS)('%s: a caller who does not belong to the thread\'s studio is refused', async (_name, call) => {
    const u = caller(ON, ON)
    u.locations = [u.locations[0]]
    delete u.assignmentsByLocation[B]
    getCurrentUser.mockResolvedValue(u)
    const res = await call()
    expect([403, 404]).toContain(res.status)
  })
})
