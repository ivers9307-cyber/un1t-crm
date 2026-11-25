// INBOXFOLLOW.1 — a reply from the Instagram thread starts the follow-up
// ladder: the coach owns the thread and the wait moves to the customer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'user-1' })),
  assertLocationAccessOr404: vi.fn(() => null),
  requireInboxPermission: vi.fn(() => null),
}))
vi.mock('@/lib/agent/instagram', () => ({
  sendInstagramMessage: vi.fn(async () => ({ messageId: 'mid-1' })),
  markInstagramSeen: vi.fn(async () => true),
}))
vi.mock('@/lib/agent/channels', () => ({ resolveChannelConnection: vi.fn(async () => ({ id: 'conn-1', access_token: 'tok' })) }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'

const CONVERSATION = {
  id: 'ig-conv-1', location_id: 'loc-1', ig_user_id: 'CUST1', contact_id: null,
  agent_handed_off_at: null,
  customer_waiting_since: '2026-11-24T09:00:00.000Z',
  staff_owned_since: null,
  snoozed_until: '2999-01-01T00:00:00.000Z',
}

function makeDb(updateError = null) {
  const updates = []
  const db = {
    updates,
    from: vi.fn((table) => {
      if (table === 'instagram_conversations') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: CONVERSATION, error: null }) }) }),
          update: (patch) => { updates.push(patch); return { eq: async () => ({ error: updateError }) } },
        }
      }
      return { insert: async () => ({ error: null }) }
    }),
  }
  return db
}

const req = () => new Request('http://localhost/api/instagram/conversations/ig-conv-1/send', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi there' }),
})

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('POST /api/instagram/conversations/[id]/send — follow-up stamps', () => {
  it('stamps staff ownership, moves the wait to the customer and clears snooze', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), { params: Promise.resolve({ id: 'ig-conv-1' }) })
    expect(res.status).toBe(200)
    const patch = db.updates[0]
    expect(patch).toMatchObject({
      last_message_direction: 'outbound', agent_active: false,
      customer_waiting_since: null, handoff_requested_at: null,
      snoozed_until: null, snoozed_by: null, snooze_note: null,
      staff_nudged_at: null, staff_nudge_outcome: null,
    })
    expect(typeof patch.staff_owned_since).toBe('string')
    expect(patch.staff_waiting_since).toBe(patch.staff_owned_since)
  })
})
