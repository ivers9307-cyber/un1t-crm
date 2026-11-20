// HYROX-TC.3 — POST /api/hyrox/blocks/[id]/expand through the real withAuth
// wrapper (ROUTEWRAP.R6): the block's studio and the hyrox approval permission
// there (404 otherwise), then the body; no database text in a failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/anthropic', async (importOriginal) => ({ ...(await importOriginal()), anthropicMessages: vi.fn() }))
vi.mock('@/lib/hyrox/generate-block', async (importOriginal) => ({ ...(await importOriginal()), expandBlockWeek: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { expandBlockWeek } = await import('@/lib/hyrox/generate-block')
const { POST } = await import('./route.js')

const BLOCK_A = 'a1000000-0000-4000-8000-00000000000a'
const BLOCK_B = 'a1000000-0000-4000-8000-00000000000b'
const expand = (id = BLOCK_A, body = { week_no: 1 }) => POST(new Request(`http://localhost/api/hyrox/blocks/${id}/expand`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const owner = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: {
    hyrox_blocks: [{ id: BLOCK_A, location_id: LOC_A }, { id: BLOCK_B, location_id: LOC_B }],
    locations: [{ id: LOC_A, name: 'Studio A', settings: {} }, { id: LOC_B, name: 'Studio B', settings: {} }],
  } }))
  expandBlockWeek.mockResolvedValue({ ok: true, sessionsCreated: 3 })
})

describe('POST /api/hyrox/blocks/[id]/expand', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await expand()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 without the hyrox approval permission at the studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    expect((await expand()).status).toBe(404)
    expect(expandBlockWeek).not.toHaveBeenCalled()
  })

  it("404 for another studio's block", async () => {
    getCurrentUser.mockResolvedValue(owner())
    expect((await expand(BLOCK_B)).status).toBe(404)
    expect(expandBlockWeek).not.toHaveBeenCalled()
  })

  it("an owner expands a week of their studio's block", async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await expand()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { sessionsCreated: 3, skipped: false } })
    expect(expandBlockWeek).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ weekNo: 1, locationLabel: 'STUDIO A' }))
  })

  it("keeps the planner's codes and hides database text", async () => {
    getCurrentUser.mockResolvedValue(owner())
    expandBlockWeek.mockResolvedValue({ ok: false, error: 'no_arc_week' })
    expect(await (await expand()).json()).toEqual({ success: false, error: 'no_arc_week' })
    expandBlockWeek.mockResolvedValue({ ok: false, error: 'duplicate key value violates unique constraint "hyrox_sessions_pkey"' })
    const res = await expand()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('session_save_failed')
  })
})
