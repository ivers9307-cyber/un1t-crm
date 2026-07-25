// Tests for POST /api/whatsapp/conversations/[id]/send — sent_by attribution.
//
// whatsapp_messages.sent_by is UUID REFERENCES profiles(id) (mig 007). The
// operator's id must be taken from the SESSION (user.id), never from the
// request body — the same latent class the composer send + radar-outreach
// (RADAR-TAKEOVER.1) were hardened against. Two properties, one per test:
//
//   - web-style send (body includes sent_by): the client value is IGNORED;
//     the logged sent_by is the session user.id. (WAInbox posts sent_by, but
//     a spoofed/mismatched value must not be trusted.)
//   - mobile-style send (body omits sent_by): mobile's whatsapp-api.js never
//     sends sent_by, so the row must still be attributed to user.id — not
//     null. A null sent_by is what excluded mobile operator sends from the
//     human-outbound / handoff-SLA scans.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Real-shaped stand-in: caller must be assigned to the row's location,
  // else a 404 (IDOR guard). Mirrors the broadcast-send route test.
  assertLocationAccessOr404: (user, locationId) => {
    if (user?.role === 'master') return null
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
  // Inbox channel gate (INBOX-PERM.1): 403 Response when the channel
  // permission is explicitly off, null otherwise. Real resolver behaviour
  // is pinned in src/lib/auth.test.js; here the send user has no
  // permissions override, so the guard passes and we reach the insert.
  requireInboxPermission: (user, _channel) => {
    if (user?.permissions?.whatsapp === false) {
      return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

// Stub the Meta-facing send helpers; the text path only needs
// isWindowOpen (window open) + sendTextMessage (returns a message id).
vi.mock('@/lib/whatsapp', () => ({
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  isWindowOpen: vi.fn(),
  substituteTemplateBody: vi.fn(),
  headerComponentFor: vi.fn(),
}))

// NOTE: @/lib/validate (real Zod SendMessageSchema) and @/lib/agent/core
// (pure manualTakeoverPatch) are deliberately NOT mocked — the point is to
// exercise the real schema + real conversation patch.

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendTextMessage, isWindowOpen } from '@/lib/whatsapp'

// ─── IDs ─────────────────────────────────────────────────────────────────────

const CONV_ID    = 'a0000000-0000-0000-0000-000000000001'
const CONTACT_ID = 'b0000000-0000-0000-0000-000000000002'
const USER_ID    = 'c0000000-0000-0000-0000-000000000003'
const LOC_ID     = 'd0000000-0000-0000-0000-000000000004'
// A client-supplied sent_by that must NOT be trusted (≠ USER_ID).
const SPOOFED_ID = 'e0000000-0000-0000-0000-000000000005'

const USER = { id: USER_ID, role: 'staff', full_name: 'Sam Staff', locations: [{ id: LOC_ID }] }

const CONVERSATION = {
  id: CONV_ID,
  location_id: LOC_ID,
  wa_phone: '353871234567',
  agent_handed_off_at: null,
  window_expires_at: '2999-01-01T00:00:00.000Z',
  contacts: { id: CONTACT_ID, name: 'Jane Member', wa_phone: '353871234567', location_id: LOC_ID },
}

// ─── DB mock ──────────────────────────────────────────────────────────────────

// insert spy — the route does `await db.from('whatsapp_messages').insert(row)`
// with no chained .select(), so insert resolves directly.
function captureInsert() {
  let captured = null
  const spy = vi.fn((payload) => {
    captured = payload
    return Promise.resolve({ error: null })
  })
  spy.captured = () => captured
  return spy
}

function makeDb({ conversation = CONVERSATION, insertSpy }) {
  return {
    from: vi.fn((table) => {
      if (table === 'whatsapp_conversations') {
        return {
          // 1) load the conversation
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: conversation, error: null })),
            })),
          })),
          // 2) last-message + manual-takeover patch
          update: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ error: null })),
          })),
        }
      }
      if (table === 'whatsapp_messages') {
        return { insert: insertSpy }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

// ─── Request helpers ──────────────────────────────────────────────────────────

const BASE_URL = `http://localhost/api/whatsapp/conversations/${CONV_ID}/send`

function postReq(body = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const props = { params: { id: CONV_ID } }

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  isWindowOpen.mockReturnValue(true)
  sendTextMessage.mockResolvedValue({ messageId: 'wamid.TEST' })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/whatsapp/conversations/[id]/send — sent_by is server-derived', () => {
  it('logs sent_by = session user.id for a web-style send, ignoring the body value', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ insertSpy }))

    // Web (WAInbox) includes sent_by in the body — here a value that does NOT
    // match the session user, to prove the route no longer trusts the body.
    const res = await POST(postReq({ type: 'text', text: 'hello', sent_by: SPOOFED_ID }), props)
    expect(res.status).toBe(200)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.captured()
    expect(payload.sent_by).toBe(USER_ID)
    expect(payload.sent_by).not.toBe(SPOOFED_ID)
  })

  it('logs sent_by = session user.id for a mobile-style send that omits sent_by', async () => {
    const insertSpy = captureInsert()
    createServerClient.mockReturnValue(makeDb({ insertSpy }))

    // Mobile (whatsapp-api.js sendText) posts { type, text } with NO sent_by.
    const res = await POST(postReq({ type: 'text', text: 'hello' }), props)
    expect(res.status).toBe(200)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    const payload = insertSpy.captured()
    expect(payload.sent_by).toBe(USER_ID)
  })
})
