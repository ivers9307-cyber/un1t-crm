// Tests for POST /api/whatsapp/conversations/[id]/react.
//
// CHECKINSTALL.2 (C104 review) — a staff reaction is NOT a reply, so its
// thread row deliberately carries NO sent_by (unlike send, send-flow and
// send-carousel). Several paths read sent_by as "a person replied": the
// handoff SLA's humanFilter (a 👍 would cancel the 60-min manager
// escalation), runHandoffAutoResolve (8h instead of 48h), and Mia's mid-reply
// takeover and cooldown re-arm. Attributing reactions would change all of
// those, which Richard has not approved. The consequence, pinned in
// followups-checkin-human.test.js: a staff reaction does not park a
// first-class check-in.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
  requireWhatsAppInboxAnywhere: () => null,
  requireWhatsAppInboxAt: () => null,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendReaction: vi.fn(async () => ({ messageId: 'wamid.REACT1' })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendReaction } from '@/lib/whatsapp'

const CONV_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID = 'c0000000-0000-0000-0000-000000000003'
const LOC_ID = 'd0000000-0000-0000-0000-000000000004'
const USER = { id: USER_ID, role: 'staff', locations: [{ id: LOC_ID }] }
// Synthetic number (the 555 range): this repo is public.
const CONVERSATION = { id: CONV_ID, location_id: LOC_ID, contact_id: 'b0000000-0000-0000-0000-000000000002', wa_phone: '15555550100' }

function stubDb({ insertError = null, readError = null } = {}) {
  const inserts = []
  return {
    inserts,
    from(table) {
      const b = {
        select: () => b, eq: () => b, maybeSingle: () => b,
        insert: async (row) => { inserts.push({ table, row }); return { error: insertError } },
        then: (ok, bad) => Promise.resolve(readError
          ? { data: null, error: readError }
          : { data: table === 'whatsapp_conversations' ? CONVERSATION : null, error: null }).then(ok, bad),
      }
      return b
    },
  }
}
const BOOM = { message: 'canceling statement due to statement timeout', code: '57014' }

const post = (body) => POST(
  new Request(`http://x/api/whatsapp/conversations/${CONV_ID}/react`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: CONV_ID }) },
)

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(USER) })

describe('POST /api/whatsapp/conversations/[id]/react', () => {
  it('records the reaction thread row with NO sent_by (a reaction is not a reply)', async () => {
    const db = stubDb()
    createServerClient.mockReturnValue(db)
    const res = await post({ message_id: 'wamid.IN1', emoji: '👍' })
    expect(res.status).toBe(200)
    expect(sendReaction).toHaveBeenCalledTimes(1)
    const rows = db.inserts.filter((i) => i.table === 'whatsapp_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].row).toMatchObject({ direction: 'outbound', message_type: 'reaction', body: 'Reacted: 👍' })
    expect(rows[0].row.sent_by ?? null).toBeNull()
  })

  it('a removed reaction carries no sent_by either', async () => {
    const db = stubDb()
    createServerClient.mockReturnValue(db)
    await post({ message_id: 'wamid.IN1', emoji: '' })
    expect(db.inserts[0].row).toMatchObject({ body: 'Removed reaction' })
    expect(db.inserts[0].row.sent_by ?? null).toBeNull()
  })
})

// CHECKINRISKS.1 (C106 e) — the thread-row insert sat in a try/catch, which
// never fires for supabase-js: the builder RESOLVES with { error }. A failed
// insert was therefore silent. Meta already has the reaction, so the action
// still succeeds (a failure answer would invite a second send), but the loss
// is logged structurally and the response says the row is missing.
describe('POST /api/whatsapp/conversations/[id]/react — a failed thread-row insert (CHECKINRISKS.1)', () => {
  let errSpy
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => errSpy.mockRestore())

  it('is logged and reported as a warning, and the reaction still stands', async () => {
    createServerClient.mockReturnValue(stubDb({ insertError: BOOM }))
    const res = await post({ message_id: 'wamid.IN1', emoji: '👍' })
    expect(res.status).toBe(200)
    // The inbox alerts `warnings` (the send route's convention). Plain text, no em-dash.
    const body = await res.json()
    expect(body).toEqual({ success: true, warnings: [expect.any(String)] })
    expect(body.warnings[0]).toMatch(/reaction was sent/)
    expect(body.warnings[0]).not.toMatch(/\u2014/)
    expect(sendReaction).toHaveBeenCalledTimes(1)
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toMatch(/thread row insert failed/)
  })

  it('a clean insert carries no warning', async () => {
    createServerClient.mockReturnValue(stubDb())
    const res = await post({ message_id: 'wamid.IN1', emoji: '👍' })
    expect(await res.json()).toEqual({ success: true })
  })

  it('a failed conversation read is a 500, not "Not found", and nothing is sent', async () => {
    createServerClient.mockReturnValue(stubDb({ readError: BOOM }))
    const res = await post({ message_id: 'wamid.IN1', emoji: '👍' })
    expect(res.status).toBe(500)
    expect(sendReaction).not.toHaveBeenCalled()
  })
})
