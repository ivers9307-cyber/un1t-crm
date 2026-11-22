// INBOXASSIGN.1 — POST/GET /api/instagram/conversations/[id]/assign. Same
// code path as WhatsApp (src/lib/inbox-assignment.js); the gate is the other
// Instagram thread routes' (the web whatsapp key at any studio, membership of
// the thread's studio as a 404, then the key AT the thread's studio as a 403 —
// SECGAPS.1). Instagram is disconnected in production, so
// these tests are the only place this route runs today.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => {
  const deny = (status) => new Response(JSON.stringify({ success: false, error: 'no' }), { status })
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: (user, loc) => ((user?.locations || []).some(l => l.id === loc) ? null : deny(404)),
    requireWebWhatsAppInboxAnywhere: vi.fn((user) => (user?.ig ? null : deny(403))),
    requireWebWhatsAppInboxAt: vi.fn((user, loc) => ((user?.igAt || []).includes(loc) ? null : deny(403))),
  }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser, requireWebWhatsAppInboxAnywhere, requireWebWhatsAppInboxAt } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  memoryDb, staffWorld, LOC_A, LOC_B, ME, ALEX, BLAIR, CASEY, DREW,
} from '@/lib/inbox-assignment.test-helpers'

const T_A = 'eeeeeeee-0000-4000-8000-00000000000a'
const T_B = 'eeeeeeee-0000-4000-8000-00000000000b'
const caller = { id: ME, role: 'manager', locations: [{ id: LOC_A }], ig: true, igAt: [LOC_A] }

let db
function setup(opts) {
  db = memoryDb(staffWorld({
    instagram_conversations: [
      { id: T_A, location_id: LOC_A, assigned_to: null },
      { id: T_B, location_id: LOC_B, assigned_to: null },
    ],
  }), opts)
  createServerClient.mockReturnValue(db)
}
const post = (id, body) => POST(
  new Request('http://x/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
)
const get = (id) => GET(new Request('http://x/api'), { params: Promise.resolve({ id }) })
const wrote = () => db.calls.some(c => c.op === 'update')
const owner = (id) => db.state.instagram_conversations.find(t => t.id === id).assigned_to

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(caller)
  setup()
})

describe('POST /api/instagram/conversations/[id]/assign', () => {
  it('401 when signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_A, { assignee: 'me' })).status).toBe(401)
  })

  it('assigns to me through the Instagram gate', async () => {
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(200)
    expect(owner(T_A)).toBe(ME)
    expect(requireWebWhatsAppInboxAnywhere).toHaveBeenCalledWith(caller)
    expect(requireWebWhatsAppInboxAt).toHaveBeenCalledWith(caller, LOC_A)
  })

  it('SECGAPS.1 — a member of the thread\'s studio without the inbox key THERE is refused (403), nothing written', async () => {
    getCurrentUser.mockResolvedValue({ ...caller, locations: [{ id: LOC_A }, { id: LOC_B }], igAt: [LOC_A] })
    expect((await post(T_B, { assignee: 'me' })).status).toBe(403)
    expect((await get(T_B)).status).toBe(403)
    expect(wrote()).toBe(false)
  })

  it('a caller without the inbox permission is refused before any read', async () => {
    getCurrentUser.mockResolvedValue({ ...caller, ig: false })
    expect((await post(T_A, { assignee: 'me' })).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('another studio\'s thread is a 404 and nothing is written', async () => {
    expect((await post(T_B, { assignee: 'me' })).status).toBe(404)
    expect(wrote()).toBe(false)
  })

  it('names an eligible colleague; refuses one without the channel, at another studio, or deleted', async () => {
    expect((await post(T_A, { assignee: ALEX })).status).toBe(200)
    for (const who of [BLAIR, CASEY, DREW]) {
      const res = await post(T_A, { assignee: who })
      expect(res.status).toBe(400)
    }
    expect(owner(T_A)).toBe(ALEX)
  })

  it('unassigns', async () => {
    db.state.instagram_conversations[0].assigned_to = ALEX
    expect((await post(T_A, { assignee: null })).status).toBe(200)
    expect(owner(T_A)).toBe(null)
  })

  it('a failed or zero-row write is not a success', async () => {
    setup({ fail: { 'instagram_conversations:update': { message: 'boom' } } })
    expect((await post(T_A, { assignee: 'me' })).status).toBe(500)
    setup({ zeroRowUpdate: ['instagram_conversations'] })
    expect((await post(T_A, { assignee: 'me' })).status).toBe(409)
  })
})

describe('GET /api/instagram/conversations/[id]/assign', () => {
  it('names only, and 404 for another studio', async () => {
    const res = await get(T_A)
    const { data } = await res.json()
    for (const s of data.staff) expect(Object.keys(s).sort()).toEqual(['full_name', 'id'])
    expect(data.staff.map(s => s.id)).not.toContain(CASEY)
    expect((await get(T_B)).status).toBe(404)
  })
})
