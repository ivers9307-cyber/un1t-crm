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

  it('resuming hands a staff-owned thread back: the clocks clear and Mia is re-armed', async () => {
    getCurrentUser.mockResolvedValue(inbox())
    Object.assign(thread(T_A), {
      agent_active: false, agent_handed_off_at: '2026-11-25T10:00:00Z', handoff_escalated_at: '2026-11-25T10:30:00Z',
      staff_owned_since: '2026-11-25T10:00:00Z', staff_waiting_since: '2026-11-25T10:00:00Z', customer_waiting_since: '2026-11-25T09:00:00Z',
      staff_nudged_at: '2026-11-25T11:00:00Z', staff_nudge_outcome: 'sent', handoff_requested_at: '2026-11-25T09:30:00Z',
      snoozed_until: '2026-11-26T00:00:00Z', snoozed_by: 'u1', snooze_note: 'later',
    })
    const res = await patch(T_A, { active: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, agent_active: true })
    expect(thread(T_A)).toMatchObject({
      agent_active: true, agent_handed_off_at: null, handoff_escalated_at: null,
      staff_owned_since: null, staff_waiting_since: null, customer_waiting_since: null,
      staff_nudged_at: null, staff_nudge_outcome: null, handoff_requested_at: null,
      snoozed_until: null, snoozed_by: null, snooze_note: null,
    })
  })

  it('pausing writes only agent_active, the first hand-off stamp and updated_at', async () => {
    getCurrentUser.mockResolvedValue(inbox())
    Object.assign(thread(T_A), { staff_owned_since: '2026-11-25T10:00:00Z' })
    await patch()
    expect(thread(T_A).staff_owned_since).toBe('2026-11-25T10:00:00Z')
    expect(thread(T_A).agent_active).toBe(false)
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

describe('INBOXPERM.1 — web OR phone key (the phone calls this route), nothing read beyond the gate select when refused', () => {
  it('the phone key alone is enough at the thread\'s studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: false, mobile: { whatsapp: true } } } }, LOC_A))
    expect((await patch()).status).toBe(200)
    expect(thread(T_A).agent_active).toBe(false)
  })

  it('a member without the key at the thread\'s studio: 403, only the gate select ran', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: false } } }, LOC_A))
    expect((await patch(T_B)).status).toBe(403)
    expect(db.calls.every((c) => c.table === 'instagram_conversations' && c.op === 'select')).toBe(true)
  })
})
