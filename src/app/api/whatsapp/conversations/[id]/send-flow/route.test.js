// Tests for POST /api/whatsapp/conversations/[id]/send-flow.
//
// CHECKINSTALL.2 (C106 b) — a staff-sent booking Flow is a PERSON acting on
// the thread. The thread row carries sent_by = the acting staff member's
// profile id, taken from the SESSION (same as the send route), so Mia's live
// reply path and the first-class check-in runner (both read sent_by) never
// mistake it for an automation.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    const ids = (user?.locations || []).map((l) => l.id)
    if (ids.includes(locationId)) return null
    return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
  requireInboxPermission: () => null,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ sendFlowMessage: vi.fn(async () => ({ messageId: 'wamid.FLOW1' })) }))

import { POST } from './route.js'
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

function stubDb() {
  const inserts = []
  return {
    inserts,
    from(table) {
      const data = table === 'whatsapp_conversations' ? CONVERSATION : table === 'locations' ? LOCATION : null
      const b = {
        select: () => b, eq: () => b, maybeSingle: () => b, single: () => b,
        insert: async (row) => { inserts.push({ table, row }); return { error: null } },
        then: (ok, bad) => Promise.resolve({ data, error: null }).then(ok, bad),
      }
      return b
    },
  }
}

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
  })
})
