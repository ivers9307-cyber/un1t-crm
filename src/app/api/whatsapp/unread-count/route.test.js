// ROUTEWRAP.R9 — GET /api/whatsapp/unread-count on withAuth: signed out is
// withAuth's 401 (the badge pollers keep their last count on a non-ok answer),
// no whatsapp permission or no active studio is still 0, and the count is the
// active studio's threads that need a human. Ids are synthetic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/inbox-followup-config', () => ({ readInboxFollowupConfig: vi.fn(async () => ({ quietHours: 48, nudgeEnabled: false })) }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', async (importOriginal) => ({ ...(await importOriginal()), hasPermission: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { readInboxFollowupConfig } from '@/lib/inbox-followup-config'
import { LOC_A, person } from '../../../../../tests/helpers/owner-at-location-callers.js'

const NEEDS_REPLY = { resolved_at: null, last_message_at: '2026-11-20T10:00:00Z', last_message_direction: 'inbound', agent_handed_off_at: null }
const ANSWERED = { resolved_at: null, last_message_at: '2026-11-20T10:00:00Z', last_message_direction: 'outbound', agent_handed_off_at: null }

let reads
let selects
beforeEach(() => {
  vi.clearAllMocks()
  reads = []
  selects = []
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'staff' }, LOC_A))
  hasPermission.mockReturnValue(true)
  const rows = { whatsapp_conversations: [NEEDS_REPLY, ANSWERED, NEEDS_REPLY], instagram_conversations: [NEEDS_REPLY] }
  createServerClient.mockReturnValue({
    from(table) {
      const chain = {
        select: (cols) => { selects.push([table, cols]); return chain },
        eq: (col, val) => { reads.push([table, col, val]); return chain },
        is: () => chain,
        then: (ok, bad) => Promise.resolve({ data: rows[table], error: null }).then(ok, bad),
      }
      return chain
    },
  })
})

describe('GET /api/whatsapp/unread-count', () => {
  it('signed out is withAuth\'s 401 and reads nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/whatsapp/unread-count'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(reads).toEqual([])
  })

  it('no whatsapp permission is still a count of 0, nothing read', async () => {
    hasPermission.mockReturnValue(false)
    const res = await GET(new Request('http://localhost/api/whatsapp/unread-count'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { count: 0 } })
    expect(hasPermission).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), 'whatsapp')
    expect(reads).toEqual([])
  })

  it('no active studio is 0', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: 'staff' }, LOC_A), activeLocation: null })
    expect(await (await GET(new Request('http://localhost/x'))).json()).toEqual({ success: true, data: { count: 0 } })
    expect(reads).toEqual([])
  })

  it('counts the active studio\'s threads that need a human, both channels', async () => {
    const res = await GET(new Request('http://localhost/x'))
    expect(await res.json()).toEqual({ success: true, data: { count: 3 } })
    expect(reads).toEqual([['whatsapp_conversations', 'location_id', LOC_A], ['instagram_conversations', 'location_id', LOC_A]])
  })

  // INBOXFOLLOW.1 — the badge reads the follow-up columns the rules read, and a
  // thread a coach replied to leaves the count until its quiet window has passed.
  it('selects the columns the queue rules read, including handoff_requested_at', async () => {
    await GET(new Request('http://localhost/x'))
    for (const [, cols] of selects) {
      for (const col of ['customer_waiting_since', 'staff_owned_since', 'staff_waiting_since', 'staff_nudged_at', 'staff_nudge_outcome', 'handoff_requested_at', 'snoozed_until']) {
        expect(cols).toContain(col)
      }
    }
  })

  it('counts a Mia handoff request, and leaves out a coach-replied thread inside the quiet window', async () => {
    const t = new Date(Date.now() - 10 * 3600_000).toISOString()
    const rows = {
      whatsapp_conversations: [
        { ...ANSWERED, handoff_requested_at: t },
        { ...ANSWERED, last_message_at: t, staff_owned_since: t, staff_waiting_since: t },
      ],
      instagram_conversations: [],
    }
    createServerClient.mockReturnValue({
      from(table) {
        const chain = { select: () => chain, eq: () => chain, is: () => chain, then: (ok, bad) => Promise.resolve({ data: rows[table], error: null }).then(ok, bad) }
        return chain
      },
    })
    expect((await (await GET(new Request('http://localhost/x'))).json()).data.count).toBe(1)
    readInboxFollowupConfig.mockResolvedValueOnce({ quietHours: 4, nudgeEnabled: false })
    expect((await (await GET(new Request('http://localhost/x'))).json()).data.count).toBe(2)
  })
})
