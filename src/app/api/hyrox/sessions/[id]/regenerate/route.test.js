// ROUTEWRAP.R10 — POST /api/hyrox/sessions/[id]/regenerate through the real
// withAuth wrapper: signed out is the wrapper's 401; a missing session, one at
// another studio and one without the permission there all answer 404; the
// regenerated session goes back to draft.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/anthropic', () => ({ anthropicMessages: vi.fn() }))
vi.mock('@/lib/hyrox/generate', async (importOriginal) => ({ ...(await importOriginal()), expandSession: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { expandSession } = await import('@/lib/hyrox/generate')
const { POST } = await import('./route.js')

const BLOCK = 'b1000000-0000-4000-8000-0000000000b1'
const S_A = 'a1000000-0000-4000-8000-0000000000a1'
const S_B = 'a1000000-0000-4000-8000-0000000000b2'
const post = (id) => POST(new Request(`http://localhost/api/hyrox/sessions/${id}/regenerate`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const coach = (on = true) => person({ [LOC_A]: { role: 'head_coach', permissions: { approvals_hyrox_sessions: on } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({
    tables: {
      hyrox_sessions: [
        { id: S_A, block_id: BLOCK, location_id: LOC_A, week_no: 1, slot: 1, status: 'approved', phase: 'base' },
        { id: S_B, block_id: BLOCK, location_id: LOC_B, week_no: 1, slot: 1, status: 'approved', phase: 'base' },
      ],
      hyrox_blocks: [{ id: BLOCK, location_id: LOC_A, arc: { plan: [{ week_no: 1 }] }, difficulty_dial: 'standard', sessions_per_week: 3 }],
      locations: [{ id: LOC_A, name: 'Studio A', settings: {} }],
    },
  })
  createServerClient.mockReturnValue(db)
  expandSession.mockResolvedValue({ ok: true, data: { full_session: { parts: [] }, board: { lines: [] } } })
})

describe('POST /api/hyrox/sessions/[id]/regenerate', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post(S_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 without the permission there, and for another studio’s session', async () => {
    getCurrentUser.mockResolvedValue(coach(false))
    expect((await post(S_A)).status).toBe(404)
    getCurrentUser.mockResolvedValue(coach())
    expect((await post(S_B)).status).toBe(404)
    expect(expandSession).not.toHaveBeenCalled()
  })

  it('regenerates the session back to draft', async () => {
    getCurrentUser.mockResolvedValue(coach())
    const res = await post(S_A)
    expect(res.status).toBe(200)
    expect(db.tables.hyrox_sessions.find((s) => s.id === S_A).status).toBe('draft')
  })
})
