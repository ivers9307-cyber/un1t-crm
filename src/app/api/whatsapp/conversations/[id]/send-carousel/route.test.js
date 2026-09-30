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
  requireInboxPermission: () => null,
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

const post = (body) => POST(
  new Request(`http://x/api/whatsapp/conversations/${CONV_ID}/send-carousel`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: CONV_ID }) },
)

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(USER) })

describe('POST /api/whatsapp/conversations/[id]/send-carousel', () => {
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
