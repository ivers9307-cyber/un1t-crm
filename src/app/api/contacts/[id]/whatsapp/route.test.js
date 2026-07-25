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

vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
  hasMobilePermission: vi.fn(() => true),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

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
