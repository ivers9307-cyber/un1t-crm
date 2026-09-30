// Tests for POST /api/whatsapp/conversations/[id]/send-flow.
//
// CHECKINSTALL.2 (C106 b) — a staff-sent booking Flow is a PERSON acting on
// the thread. The thread row carries sent_by = the acting staff member's
// profile id, taken from the SESSION (same as the send route), so Mia's live
// reply path and the first-class check-in runner (both read sent_by) never
// mistake it for an automation.
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
vi.mock('@/lib/whatsapp', () => ({ sendFlowMessage: vi.fn(async () => ({ messageId: 'wamid.FLOW1' })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { POST } from './route.js'
import { logError } from '@/lib/log'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendFlowMessage } from '@/lib/whatsapp'

const CONV_ID = 'a0000000-0000-0000-0000-000000000001'
const CONTACT_ID = 'b0000000-0000-0000-0000-000000000002'
const USER_ID = 'c0000000-0000-0000-0000-000000000003'
const LOC_ID = 'd0000000-0000-0000-0000-000000000004'
const USER = { id: USER_ID, role: 'staff', locations: [{ id: LOC_ID }] }
// Synthetic number (the 555 range): this repo is public.
const CONVERSATION = { id: CONV_ID, location_id: LOC_ID, contact_id: CONTACT_ID, wa_phone: '15555550100' }
const LOCATION = { settings: { whatsapp_flow: { flow_id: 'flow-1', invite_text: 'Tap below to book.' } } }

function stubDb({ insertError = null, readErrors = {} } = {}) {
  const inserts = []
  return {
    inserts,
    from(table) {
      const data = table === 'whatsapp_conversations' ? CONVERSATION : table === 'locations' ? LOCATION : null
      const b = {
        select: () => b, eq: () => b, maybeSingle: () => b, single: () => b,
        insert: async (row) => { inserts.push({ table, row }); return { error: insertError } },
        then: (ok, bad) => Promise.resolve(readErrors[table]
          ? { data: null, error: readErrors[table] }
          : { data, error: null }).then(ok, bad),
      }
      return b
    },
  }
}
const BOOM = { message: 'canceling statement due to statement timeout', code: '57014' }

const post = () => POST(
  new Request(`http://x/api/whatsapp/conversations/${CONV_ID}/send-flow`, { method: 'POST' }),
  { params: Promise.resolve({ id: CONV_ID }) },
)

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(USER) })

describe('POST /api/whatsapp/conversations/[id]/send-flow', () => {
  it('records the Flow thread row with sent_by = the acting staff member', async () => {
    const db = stubDb()
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(200)
    expect(sendFlowMessage).toHaveBeenCalledTimes(1)
    const rows = db.inserts.filter((i) => i.table === 'whatsapp_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].row).toMatchObject({ direction: 'outbound', message_type: 'flow', contact_id: CONTACT_ID, sent_by: USER_ID })
    expect((await res.json()).warnings).toBeUndefined()
  })

  // FLOWTOKENDEDUP.1 (C73) — the token comes from flowTokenFor.
  it('mints the flow_token as <contactId>.<locationId>', async () => {
    createServerClient.mockReturnValue(stubDb())
    await post()
    expect(sendFlowMessage.mock.calls[0][1].flowToken).toBe(`${CONTACT_ID}.${LOC_ID}`)
  })

  // FLOWTOKENDEDUP.1 (C73) — supabase-js RESOLVES a failed insert with
  // { error }; the old try/catch could never see it. Meta already has the
  // Flow, so the send still succeeds (never a louder failure), but the loss is
  // logged structurally and staff are told not to send it again.
  it('a failed thread-row insert is logged and returned as a warning, not a failure', async () => {
    const db = stubDb()
    const base = db.from.bind(db)
    db.from = (table) => {
      const b = base(table)
      if (table === 'whatsapp_messages') b.insert = async () => ({ error: { message: 'insert refused' } })
      return b
    }
    createServerClient.mockReturnValue(db)
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0]).toMatch(/Sent to the customer, but it could not be saved to this thread/)
    expect(body.warnings[0]).not.toMatch(/—/)
    expect(logError).toHaveBeenCalledWith('wa-flow-send', expect.any(String), expect.objectContaining({ conversationId: CONV_ID, err: 'insert refused' }))
  })

  // A failed read is never an empty answer: an unreadable conversation is not
  // a 404, and unreadable settings are not "no Flow configured".
  function failingRead(failTable) {
    const db = stubDb()
    const base = db.from.bind(db)
    db.from = (table) => {
      const b = base(table)
      if (table === failTable) b.then = (ok, bad) => Promise.resolve({ data: null, error: { message: 'read refused' } }).then(ok, bad)
      return b
    }
    return db
  }

  it('a failed conversation read is a 500 and sends nothing', async () => {
    createServerClient.mockReturnValue(failingRead('whatsapp_conversations'))
    const res = await post()
    expect(res.status).toBe(500)
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })

  it('a failed settings read is a 500, not "no Flow configured", and sends nothing', async () => {
    createServerClient.mockReturnValue(failingRead('locations'))
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/No booking Flow is configured/)
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })
})

// CHECKINRISKS.1 (C106 e) — the thread-row insert sat in a try/catch, which
// never fires for supabase-js (the builder RESOLVES with { error }), so a
// failed insert was silent. It matters beyond history: that row's sent_by is
// what tells Mia and the check-in runner a person acted. Meta already sent the
// Flow, so the action still succeeds (a failure answer would invite a second
// Flow to the customer); the loss is logged and the response carries a warning.
describe('POST /api/whatsapp/conversations/[id]/send-flow — failures are not silent (CHECKINRISKS.1)', () => {
  let errSpy
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => errSpy.mockRestore())

  it('a failed thread-row insert is logged and reported as a warning; the send stands', async () => {
    createServerClient.mockReturnValue(stubDb({ insertError: BOOM }))
    const res = await post()
    expect(res.status).toBe(200)
    // The inbox alerts `warnings` (the send route's convention), so staff learn
    // the Flow WENT and do not send a second one. Plain text, no em-dash.
    const body = await res.json()
    expect(body).toEqual({ success: true, warnings: [expect.any(String)] })
    expect(body.warnings[0]).toMatch(/Sent to the customer/)
    expect(body.warnings[0]).toMatch(/Do not send it again/)
    expect(body.warnings[0]).not.toMatch(/\u2014/)
    expect(sendFlowMessage).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/thread row insert failed/), expect.anything())
  })

  it('a clean insert carries no warning', async () => {
    createServerClient.mockReturnValue(stubDb())
    expect(await (await post()).json()).toEqual({ success: true })
  })

  it('a failed conversation read is a 500, not "Not found"', async () => {
    createServerClient.mockReturnValue(stubDb({ readErrors: { whatsapp_conversations: BOOM } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })

  it('a failed settings read is a 500, not "No booking Flow is configured"', async () => {
    createServerClient.mockReturnValue(stubDb({ readErrors: { locations: BOOM } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/No booking Flow/)
    expect(sendFlowMessage).not.toHaveBeenCalled()
  })
})
