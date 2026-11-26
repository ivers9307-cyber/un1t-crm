// INBOXFOLLOW.1 — a reply from the Instagram thread starts the follow-up
// ladder: the coach owns the thread and the wait moves to the customer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/agent/instagram', () => ({
  sendInstagramMessage: vi.fn(async () => ({ messageId: 'mid-1' })),
  markInstagramSeen: vi.fn(async () => true),
}))
vi.mock('@/lib/agent/channels', () => ({ resolveChannelConnection: vi.fn(async () => ({ id: 'conn-1', access_token: 'tok' })) }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

const CONVERSATION = {
  id: 'ig-conv-1', location_id: LOC_A, ig_user_id: 'CUST1', contact_id: null,
  agent_handed_off_at: null,
  customer_waiting_since: '2026-11-24T09:00:00.000Z',
  staff_owned_since: null,
  snoozed_until: '2999-01-01T00:00:00.000Z',
}

function makeDb(updateError = null, conversation = CONVERSATION) {
  const updates = []
  const reads = []
  const db = {
    updates,
    reads,
    from: vi.fn((table) => {
      if (table === 'instagram_conversations') {
        return {
          select: () => { reads.push('instagram_conversations'); return { eq: () => ({ single: async () => ({ data: conversation, error: null }) }) } },
          update: (patch) => { updates.push(patch); return { eq: async () => ({ error: updateError }) } },
        }
      }
      reads.push(table)
      return { insert: async () => ({ error: null }) }
    }),
  }
  return db
}

const req = () => new Request('http://localhost/api/instagram/conversations/ig-conv-1/send', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi there' }),
})

const withKey = (perms = { whatsapp: true }) => person({ [LOC_A]: { role: 'staff', permissions: perms } }, LOC_A)
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  getCurrentUser.mockResolvedValue(withKey())
})

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

describe('POST /api/instagram/conversations/[id]/send — INBOXPERM.1 gates', () => {
  const callSend = () => POST(req(), { params: Promise.resolve({ id: 'ig-conv-1' }) })
  const atB = { ...CONVERSATION, location_id: LOC_B }
  const noKeyAtB = () => person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A)

  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await callSend()).status).toBe(401)
  })

  it('403 without the key at any studio, before anything is read', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(withKey({ whatsapp: false }))
    expect((await callSend()).status).toBe(403)
    expect(db.reads).toEqual([])
  })

  it('403 at a member studio without the key (held only at the active studio): the gate select ran, nothing was written or sent', async () => {
    const db = makeDb(null, atB)
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(noKeyAtB())
    expect((await callSend()).status).toBe(403)
    expect(db.updates).toEqual([])
    expect(db.reads).toEqual(['instagram_conversations'])
  })

  it('404, never 403, for a thread at a studio the caller is not a member of', async () => {
    const db = makeDb(null, atB)
    createServerClient.mockReturnValue(db)
    expect((await callSend()).status).toBe(404)
    expect(db.updates).toEqual([])
  })

  it('the key held at the thread\'s studio but not the active one is enough', async () => {
    const db = makeDb(null, atB)
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A))
    expect((await callSend()).status).toBe(200)
  })

  it('the phone key alone is enough (the phone calls this route)', async () => {
    createServerClient.mockReturnValue(makeDb())
    getCurrentUser.mockResolvedValue(withKey({ whatsapp: false, mobile: { whatsapp: true } }))
    expect((await callSend()).status).toBe(200)
  })
})
