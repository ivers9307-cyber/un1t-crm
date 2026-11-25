// Tests for POST /api/whatsapp/conversations/[id]/send-carousel.
//
// CHECKINSTALL.2 (C106 b) — a staff card-set send is a PERSON acting on the
// thread. The route threads the SESSION's profile id into the shared helper
// (whatsapp-carousel-send.js, run for real here), so the stored thread row
// carries sent_by and Mia's reply path and the first-class check-in runner
// (both read sent_by) never mistake it for an automation.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('@/lib/whatsapp', () => ({ sendMediaCarousel: vi.fn(async () => ({ messageId: 'wamid.CAROUSEL1' })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendMediaCarousel } from '@/lib/whatsapp'

const CONV_ID = 'a0000000-0000-0000-0000-000000000001'
const USER_ID = 'c0000000-0000-0000-0000-000000000003'
const LOC_ID = 'd0000000-0000-0000-0000-000000000004'
const SET_ID = 'f0000000-0000-0000-0000-000000000006'
const USER = { id: USER_ID, role: 'staff', locations: [{ id: LOC_ID }] }
// Synthetic number (the 555 range): this repo is public.
const CONVERSATION = { id: CONV_ID, location_id: LOC_ID, contact_id: 'b0000000-0000-0000-0000-000000000002', wa_phone: '15555550100' }
const LOCATION = { settings: { wa_card_sets: [{ id: SET_ID, name: 'Membership', body_text: 'Our options', cards: [{ image_url: 'https://cdn.test/1.jpg', title: 'Unlimited' }] }] } }

function stubDb() {
  const inserts = []
  const updates = []
  return {
    inserts, updates,
    from(table) {
      const data = table === 'whatsapp_conversations' ? CONVERSATION : table === 'locations' ? LOCATION : null
      const b = {
        select: () => b, eq: () => b, maybeSingle: () => b, single: () => b,
        update: (patch) => { updates.push({ table, patch }); return b },
        insert: async (row) => { inserts.push({ table, row }); return { error: null } },
        then: (ok, bad) => Promise.resolve({ data, error: null }).then(ok, bad),
      }
      return b
    },
  }
}

const post = (body) => POST(
  new Request(`http://x/api/whatsapp/conversations/${CONV_ID}/send-carousel`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: CONV_ID }) },
)

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(USER) })

describe('POST /api/whatsapp/conversations/[id]/send-carousel', () => {
  // INBOXFOLLOW.1 — sent from the thread: the coach owns it and the wait moves to the customer.
  it('is a full coach reply: last-message columns, Mia take-over and the follow-up ladder', async () => {
    const db = stubDb()
    createServerClient.mockReturnValue(db)
    const res = await post({ card_set_id: SET_ID })
    expect(res.status).toBe(200)
    expect(db.updates).toHaveLength(1)
    const { table, patch } = db.updates[0]
    expect(table).toBe('whatsapp_conversations')
    expect(patch).toMatchObject({
      customer_waiting_since: null, handoff_requested_at: null, snoozed_until: null,
      staff_nudged_at: null, staff_nudge_outcome: null,
    })
    expect(typeof patch.staff_owned_since).toBe('string')
    expect(patch.staff_waiting_since).toBe(patch.staff_owned_since)
    expect(patch).toMatchObject({
      last_message_direction: 'outbound', last_message_preview: '[Card set: Membership]', agent_active: false,
    })
    expect(typeof patch.last_message_at).toBe('string')
    expect(typeof patch.agent_handed_off_at).toBe('string')
    expect(patch.staff_owned_since).toBe(patch.last_message_at)
  })

  it('records the carousel thread row with sent_by = the acting staff member, and no source', async () => {
    const db = stubDb()
    createServerClient.mockReturnValue(db)
    const res = await post({ card_set_id: SET_ID })
    expect(res.status).toBe(200)
    expect(sendMediaCarousel).toHaveBeenCalledTimes(1)
    const rows = db.inserts.filter((i) => i.table === 'whatsapp_messages')
    expect(rows).toHaveLength(1)
    expect(rows[0].row).toMatchObject({ direction: 'outbound', message_type: 'carousel', body: '[Card set: Membership]', sent_by: USER_ID })
    expect('source' in rows[0].row).toBe(false)
  })
})

// ROUTEWRAP.R9 — on withAuth: signed out is its 401, and Meta's own error
// text is logged, never answered.
describe('POST /api/whatsapp/conversations/[id]/send-carousel — wrapper and Meta errors', () => {
  it('signed out: 401 Unauthorized, nothing read or sent', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post({ card_set_id: SET_ID })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createServerClient).not.toHaveBeenCalled()
    expect(sendMediaCarousel).not.toHaveBeenCalled()
  })

  it('a Meta failure: 502 with a fixed line, not Meta\'s text', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    createServerClient.mockReturnValue(stubDb())
    sendMediaCarousel.mockRejectedValueOnce(new Error('(#131009) Parameter value is not valid for 15555550100'))
    const res = await post({ card_set_id: SET_ID })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Meta carousel call failed' })
    errSpy.mockRestore()
  })
})
