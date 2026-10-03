// Tests for POST /api/contacts/[id]/whatsapp (CONTACT-COMPOSER.1 send + log)
//
// Regression coverage for the sent_by bug: whatsapp_messages.sent_by is a UUID
// column (mig 007 → `UUID REFERENCES profiles(id)`). The composer send route
// must log the session user's profiles.id, NOT their display name. Writing a
// name string ("Sam Staff") raises `invalid input syntax for type uuid`, which
// supabase-js returns on the result object rather than throwing; the route
// never checks `.error`, so the whatsapp_messages row is silently dropped on
// every named-operator send (and, with no sent_by, the send stops counting as a
// human-outbound row for Mia's handoff-SLA / re-arm scans). This test pins
// sent_by === user.id, matching the inbox and radar-outreach send paths.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => {
  // ROLESWEEP.1c — the route asks the any-location pre-check and the
  // at-the-target decision; both follow this file's switch below.
  const hasPermission = vi.fn(() => true)
  const hasMobilePermission = vi.fn(() => true)
  return {
    hasPermission,
    hasPermissionAtAnyLocation: (u, k) => hasPermission(u, k),
    hasPermissionForLocation: (u, _loc, k) => hasPermission(u, k),
    hasMobilePermission,
    hasMobilePermissionAtAnyLocation: (u, k) => hasMobilePermission(u, k),
    hasMobilePermissionForLocation: (u, _loc, k) => hasMobilePermission(u, k),
  }
})

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// WACONFIGFALLBACK.1 — the route checks the location's OWN number before
// opening a thread; the default is "has one" (the no-number case is at the end).
// WAREPLYNUMBER.1 review — the thread's own number (null = none recorded);
// pickReplyConfig is the real rule.
vi.mock('@/lib/whatsapp-config', async () => ({
  getLocationWhatsAppNumberConfig: vi.fn(async () => ({ source: 'db', id: 'n1' })),
  getConversationNumberConfig: vi.fn(async () => null),
  pickReplyConfig: (await vi.importActual('@/lib/whatsapp-config')).pickReplyConfig,
}))

// Stub the WhatsApp transport — no real Meta call, 24h window always open.
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(() => Promise.resolve({ messageId: 'wamid.TEST123' })),
  sendTemplateMessage: vi.fn(() => Promise.resolve({ messageId: 'wamid.TEST123' })),
  isWindowOpen: vi.fn(() => true),
  headerComponentFor: vi.fn(() => null),
}))

// manualTakeoverPatch only contributes fields to the conversation update.
vi.mock('@/lib/agent/core', () => ({
  manualTakeoverPatch: vi.fn(() => ({})),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONTACT_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID    = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID     = 'c0000000-0000-0000-0000-000000000003'
const CONV_ID    = 'e0000000-0000-0000-0000-000000000005'

const CONTACT = {
  id: CONTACT_ID,
  name: 'Casey Customer',
  first_name: 'Casey',
  phone: null,
  wa_phone: '+353111111111',
  location_id: LOC_ID,
}
const CONVERSATION = {
  id: CONV_ID,
  window_expires_at: '2999-01-01T00:00:00Z',
  location_id: LOC_ID,
  agent_handed_off_at: null,
}
// full_name is a display name, NOT a uuid — exactly the value the buggy route
// wrote into the uuid sent_by column.
const STAFF = { id: USER_ID, role: 'staff', full_name: 'Sam Staff', locations: [{ id: LOC_ID }] }

// ─── DB mock ──────────────────────────────────────────────────────────────────

// insert spy for whatsapp_messages that captures the payload (the route awaits
// the insert directly — no .select() is chained after it).
function echoInsert() {
  let captured = null
  const spy = vi.fn((payload) => {
    captured = payload
    return Promise.resolve({ data: null, error: null })
  })
  spy.captured = () => captured
  return spy
}

function makeDb(messageInsertSpy, { contact = CONTACT, conversation = CONVERSATION } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: contact, error: null }),
            }),
          }),
        }
      }
      if (table === 'whatsapp_conversations') {
        return {
          // get-or-create read: .select().eq().order().limit()
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: conversation ? [conversation] : [] }),
              }),
            }),
          }),
          // post-send update: .update().eq()
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        }
      }
      if (table === 'whatsapp_messages') {
        return { insert: messageInsertSpy }
      }
      if (table === 'activities') {
        return { insert: () => Promise.resolve({ data: null, error: null }) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

// ─── Request helper ────────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/contacts/${CONTACT_ID}/whatsapp`

function postReq(body = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const props = { params: { id: CONTACT_ID } }

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  hasMobilePermission.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(STAFF)
})

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/contacts/[id]/whatsapp', () => {
  it('logs sent_by as the session user id (a uuid), not their display name', async () => {
    const insertSpy = echoInsert()
    createServerClient.mockReturnValue(makeDb(insertSpy))

    const res = await POST(postReq({ text: 'Hi Casey — following up on your trial.' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)

    // The whatsapp_messages row must be logged (not silently dropped) …
    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.captured()
    // … with sent_by = the operator's profiles.id uuid, never their name.
    expect(payload.sent_by).toBe(USER_ID)
    expect(payload.sent_by).not.toBe(STAFF.full_name)
  })
})

// WACONFIGFALLBACK.1 — the contact's location has no WhatsApp number of its
// own. The send used to go out on the global env number (another studio's);
// now it is refused BEFORE a thread is opened, so no empty thread lands in
// this location's inbox.
describe('POST /api/contacts/[id]/whatsapp — no WhatsApp number at the contact location', () => {
  it('409 with the shared message; no thread opened, nothing sent or logged', async () => {
    const { getLocationWhatsAppNumberConfig } = await import('@/lib/whatsapp-config')
    const { sendTextMessage } = await import('@/lib/whatsapp')
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(null)
    const insertSpy = echoInsert()
    const db = makeDb(insertSpy)
    createServerClient.mockReturnValue(db)

    const res = await POST(postReq({ text: 'Hi' }), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC_ID)
    expect(db.from.mock.calls.map((c) => c[0])).not.toContain('whatsapp_conversations')
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// WACONFIGFALLBACK.1 review — the send uses the number the route already
// checked ({ config }), so there is one lookup and no gap between the check
// and the send in which a different number could be resolved.
describe('POST /api/contacts/[id]/whatsapp — sends on the number it checked', () => {
  it('one lookup; the send gets { config } of that number, never a second resolve by location', async () => {
    const { getLocationWhatsAppNumberConfig } = await import('@/lib/whatsapp-config')
    const { sendTextMessage } = await import('@/lib/whatsapp')
    const NUMBER = { source: 'db', id: 'n-checked' }
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(NUMBER)
    createServerClient.mockReturnValue(makeDb(echoInsert()))

    const res = await POST(postReq({ text: 'Hi' }), props)
    expect(res.status).toBe(200)
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledTimes(1)
    expect(sendTextMessage).toHaveBeenCalledWith(expect.any(String), 'Hi', { config: NUMBER })
  })
})

// WAREPLYNUMBER.1 review (C86) — the composer's free text is a reply into the
// contact's thread (it needs the open 24h window), so it goes from the number
// the customer wrote to, like the inbox send; a template only within the
// default's WABA. Still ONE resolve by location (the checked default): the
// thread number is read by its id.
describe('POST /api/contacts/[id]/whatsapp — replies from the number the thread was written to', () => {
  const DEFAULT_NUMBER = { source: 'db', id: 'n-default', businessAccountId: 'WABA-1' }
  const SECOND = { source: 'db', id: 'n-second', businessAccountId: 'WABA-1' }
  const OTHER_WABA = { source: 'db', id: 'n-other', businessAccountId: 'WABA-2' }

  it('free text goes from the thread number; the location is resolved once', async () => {
    const { getLocationWhatsAppNumberConfig, getConversationNumberConfig } = await import('@/lib/whatsapp-config')
    const { sendTextMessage } = await import('@/lib/whatsapp')
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(DEFAULT_NUMBER)
    getConversationNumberConfig.mockResolvedValueOnce(SECOND)
    createServerClient.mockReturnValue(makeDb(echoInsert()))

    const res = await POST(postReq({ text: 'Hi' }), props)
    expect(res.status).toBe(200)
    expect(getConversationNumberConfig).toHaveBeenCalledWith(LOC_ID, CONV_ID)
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledTimes(1)
    expect(sendTextMessage).toHaveBeenCalledWith(expect.any(String), 'Hi', { config: SECOND })
  })

  it('no thread number recorded: the checked default, as before', async () => {
    const { getLocationWhatsAppNumberConfig, getConversationNumberConfig } = await import('@/lib/whatsapp-config')
    const { sendTextMessage } = await import('@/lib/whatsapp')
    getLocationWhatsAppNumberConfig.mockResolvedValueOnce(DEFAULT_NUMBER)
    getConversationNumberConfig.mockResolvedValueOnce(null)
    createServerClient.mockReturnValue(makeDb(echoInsert()))

    const res = await POST(postReq({ text: 'Hi' }), props)
    expect(res.status).toBe(200)
    expect(sendTextMessage).toHaveBeenCalledWith(expect.any(String), 'Hi', { config: DEFAULT_NUMBER })
  })

  it('a thread number on another WABA never sends a template (templates are the default WABA\'s)', async () => {
    const { pickReplyConfig } = await import('@/lib/whatsapp-config')
    expect(pickReplyConfig(OTHER_WABA, DEFAULT_NUMBER, { template: true })).toBe(DEFAULT_NUMBER)
    expect(pickReplyConfig(SECOND, DEFAULT_NUMBER, { template: true })).toBe(SECOND)
    expect(pickReplyConfig(OTHER_WABA, DEFAULT_NUMBER)).toBe(OTHER_WABA)
    expect(pickReplyConfig(null, DEFAULT_NUMBER, { template: true })).toBe(DEFAULT_NUMBER)
  })
})
