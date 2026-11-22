// PATCH /api/instagram/conversations/[id]/agent through the real withAuth
// wrapper (ROUTEWRAP.R6): the inbox permission ('ig' rides `whatsapp`), the
// body, then the thread's studio (404); no database text in a failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH } = await import('./route.js')

const T_A = 'a3000000-0000-4000-8000-00000000000a'
const T_B = 'a3000000-0000-4000-8000-00000000000b'
let db
const patch = (id = T_A, body = { active: false }) => PATCH(new Request(`http://localhost/api/instagram/conversations/${id}/agent`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const thread = (id) => db.tables.instagram_conversations.find((t) => t.id === id)
const inbox = (on = true) => person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { instagram_conversations: [
    { id: T_A, location_id: LOC_A, agent_active: true, agent_handed_off_at: null },
    { id: T_B, location_id: LOC_B, agent_active: true, agent_handed_off_at: null },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/instagram/conversations/[id]/agent', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without the inbox permission, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(inbox(false))
    expect((await patch()).status).toBe(403)
    expect(thread(T_A).agent_active).toBe(true)
  })

  it("404 for another studio's thread, nothing changed", async () => {
    getCurrentUser.mockResolvedValue(inbox())
    expect((await patch(T_B)).status).toBe(404)
    expect(thread(T_B).agent_active).toBe(true)
  })

  it("pauses Mia on a thread at the caller's studio and stamps the hand-off", async () => {
    getCurrentUser.mockResolvedValue(inbox())
    const res = await patch()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, agent_active: false })
    expect(thread(T_A).agent_active).toBe(false)
    expect(thread(T_A).agent_handed_off_at).toBeTruthy()
  })

  it('a failed write is a 500 with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(inbox())
    db.errors.instagram_conversations = { update: { code: '57014', message: 'statement timeout on instagram_conversations' } }
    const res = await patch()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/instagram_conversations/)
  })
})

describe('SECGAPS.1 — the inbox key is judged at the thread\'s studio', () => {
  it('403 at a member studio without the key, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A))
    expect((await patch(T_B)).status).toBe(403)
    expect(thread(T_B).agent_active).toBe(true)
  })

  it('changes the thread at a studio where the key is held but not at the active studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A))
    expect((await patch(T_B)).status).toBe(200)
    expect(thread(T_B).agent_active).toBe(false)
  })
})
