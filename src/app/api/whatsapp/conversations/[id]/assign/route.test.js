// INBOXASSIGN.1 — POST/GET /api/whatsapp/conversations/[id]/assign.
// The gate is the WhatsApp thread routes' own (INBOXLOC.1): membership of the
// thread's studio (404) and WhatsApp judged AT THAT STUDIO. The real guards
// are pinned in src/lib/auth.test.js; here they are stand-ins that record
// which studio they were asked about.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => {
  const deny = (status) => new Response(JSON.stringify({ success: false, error: 'no' }), { status })
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: (user, loc) => ((user?.locations || []).some(l => l.id === loc) ? null : deny(404)),
    requireWhatsAppInboxAnywhere: (user) => (user?.waAt?.length ? null : deny(403)),
    requireWhatsAppInboxAt: vi.fn((user, loc) => ((user?.waAt || []).includes(loc) ? null : deny(403))),
  }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser, requireWhatsAppInboxAt } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  memoryDb, staffWorld, LOC_A, LOC_B, ME, ALEX, BLAIR, CASEY, DREW,
} from '@/lib/inbox-assignment.test-helpers'

const T_A = 'dddddddd-0000-4000-8000-00000000000a'
const T_B = 'dddddddd-0000-4000-8000-00000000000b'
const caller = { id: ME, role: 'manager', locations: [{ id: LOC_A }], waAt: [LOC_A] }

let db
function setup(opts) {
  db = memoryDb(staffWorld({
    whatsapp_conversations: [
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
const owner = (id) => db.state.whatsapp_conversations.find(t => t.id === id).assigned_to

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(caller)
  setup()
})

describe('POST /api/whatsapp/conversations/[id]/assign', () => {
  it('401 when signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(T_A, { assignee: 'me' })).status).toBe(401)
  })

  it('assigns to me, judging WhatsApp at the THREAD\'s studio', async () => {
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ assigned_to: ME, assignee_name: 'Test Manager' })
    expect(owner(T_A)).toBe(ME)
    expect(requireWhatsAppInboxAt).toHaveBeenCalledWith(caller, LOC_A)
  })

  it('another studio\'s thread is a 404 and nothing is written', async () => {
    const res = await post(T_B, { assignee: 'me' })
    expect(res.status).toBe(404)
    expect(wrote()).toBe(false)
  })

  it('an unknown thread is a 404', async () => {
    expect((await post('dddddddd-0000-4000-8000-0000000000ff', { assignee: 'me' })).status).toBe(404)
  })

  it('a member without WhatsApp at the thread\'s studio is refused, nothing written', async () => {
    getCurrentUser.mockResolvedValue({ ...caller, locations: [{ id: LOC_A }, { id: LOC_B }], waAt: [LOC_B] })
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(403)
    expect(wrote()).toBe(false)
  })

  it('names an eligible colleague', async () => {
    const res = await post(T_A, { assignee: ALEX })
    expect(res.status).toBe(200)
    expect(owner(T_A)).toBe(ALEX)
  })

  it.each([
    ['without WhatsApp there', BLAIR],
    ['not at the studio', CASEY],
    ['a tombstone', DREW],
  ])('refuses a colleague %s', async (_l, who) => {
    const res = await post(T_A, { assignee: who })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('assignee_not_eligible')
    expect(wrote()).toBe(false)
  })

  it('unassigns', async () => {
    db.state.whatsapp_conversations[0].assigned_to = ALEX
    const res = await post(T_A, { assignee: null })
    expect(res.status).toBe(200)
    expect(owner(T_A)).toBe(null)
  })

  it('a failed write is not a success', async () => {
    setup({ fail: { 'whatsapp_conversations:update': { message: 'boom' } } })
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('a zero-row write is not a success', async () => {
    setup({ zeroRowUpdate: ['whatsapp_conversations'] })
    const res = await post(T_A, { assignee: 'me' })
    expect(res.status).toBe(409)
    expect((await res.json()).success).toBe(false)
  })

  it('rejects a malformed body', async () => {
    expect((await post(T_A, { assignee: 'someone' })).status).toBe(400)
  })
})

describe('GET /api/whatsapp/conversations/[id]/assign — the picker', () => {
  it('lists names only, scoped to the thread\'s studio and channel', async () => {
    const res = await get(T_A)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.viewer_id).toBe(ME)
    const staffIds = data.staff.map(s => s.id)
    expect(staffIds).toContain(ALEX)
    expect(staffIds).not.toContain(BLAIR)
    expect(staffIds).not.toContain(CASEY)
    expect(staffIds).not.toContain(DREW)
    for (const s of data.staff) expect(Object.keys(s).sort()).toEqual(['full_name', 'id'])
  })

  it('another studio\'s thread is a 404', async () => {
    expect((await get(T_B)).status).toBe(404)
  })
})
