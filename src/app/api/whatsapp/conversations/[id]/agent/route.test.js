// ROUTEWRAP.R9 — PATCH /api/whatsapp/conversations/[id]/agent on withAuth:
// signed out is withAuth's 401, the WEB `whatsapp` key is judged at the
// THREAD's studio (INBOXWEBONLY3.1), another studio's thread is 404, and a
// caller who passes pauses or resumes Mia on the thread. The real permission
// helpers run; only the session and the service-role client are stubbed.
// Ids are synthetic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

import { PATCH } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const CONV = '00000000-0000-4000-8000-0000000000c1'
const WEB = { whatsapp: true, mobile: { whatsapp: false } }
const OFF = { whatsapp: false, mobile: { whatsapp: false } }

const caller = (perms) => ({
  id: 'u1', role: 'staff', activeLocation: { id: A, features: {} },
  activeAssignment: { role: 'staff', permissions: perms[A] ?? OFF },
  locations: Object.keys(perms).map((id) => ({ id, role: 'staff', features: {} })),
  assignmentsByLocation: Object.fromEntries(Object.entries(perms).map(([id, p]) => [id, { role: 'staff', permissions: p }])),
  user: { id: 'u1' },
})

let updates
function fakeDb(row, updateError = null) {
  updates = []
  return {
    from: (table) => {
      const b = {
        select: () => b, eq: () => b,
        single: async () => (row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }),
        update: (patch) => { updates.push({ table, patch }); return b },
        then: (ok, bad) => Promise.resolve({ data: null, error: updateError }).then(ok, bad),
      }
      return b
    },
  }
}

const patch = (body) => PATCH(
  new Request(`http://x/api/whatsapp/conversations/${CONV}/agent`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: CONV }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(fakeDb({ id: CONV, location_id: B }))
})

describe('PATCH /api/whatsapp/conversations/[id]/agent', () => {
  it('signed out: withAuth\'s 401, nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch({ active: false })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no WEB whatsapp key at the thread\'s studio: 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: WEB, [B]: OFF }))
    expect((await patch({ active: false })).status).toBe(403)
    expect(updates).toEqual([])
  })

  it('another studio\'s thread: 404, nothing written', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: WEB }))
    expect((await patch({ active: false })).status).toBe(404)
    expect(updates).toEqual([])
  })

  it('WEB key at the thread\'s studio: pauses Mia, then resumes her', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: OFF, [B]: WEB }))
    const paused = await patch({ active: false })
    expect(paused.status).toBe(200)
    expect((await paused.json()).agent_paused_at).toEqual(expect.any(String))
    expect(updates[0]).toMatchObject({ table: 'whatsapp_conversations', patch: { agent_paused_at: expect.any(String) } })
    // pausing is exactly today's payload: no hand-back columns
    expect(Object.keys(updates[0].patch).sort()).toEqual(['agent_paused_at', 'updated_at'])
    const resumed = await patch({ active: true })
    expect(await resumed.json()).toMatchObject({ success: true, agent_paused_at: null })
  })

  it('resuming hands a staff-owned thread back: the clocks clear and Mia is re-armed', async () => {
    getCurrentUser.mockResolvedValue(caller({ [A]: OFF, [B]: WEB }))
    const res = await patch({ active: true })
    expect(res.status).toBe(200)
    expect(updates[0].patch).toEqual({
      agent_paused_at: null, updated_at: expect.any(String),
      customer_waiting_since: null, staff_owned_since: null, staff_waiting_since: null,
      staff_nudged_at: null, staff_nudge_outcome: null, handoff_requested_at: null,
      snoozed_until: null, snoozed_by: null, snooze_note: null,
      agent_active: true, agent_handed_off_at: null, handoff_escalated_at: null,
    })
  })

  it('a failed update answers 500, not success', async () => {
    createServerClient.mockReturnValue(fakeDb({ id: CONV, location_id: B }, { code: '57014', message: 'timeout' }))
    getCurrentUser.mockResolvedValue(caller({ [A]: OFF, [B]: WEB }))
    const res = await patch({ active: true })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: expect.any(String) })
  })
})
