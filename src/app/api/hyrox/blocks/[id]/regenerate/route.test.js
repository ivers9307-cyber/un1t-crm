// HYROX-TC — the block-regenerate route runs arc generation (the heaviest Claude
// call in the feature, max_tokens 8000). It MUST provision the same 300s function
// timeout as the sibling arc/session generation routes (POST /api/hyrox/blocks,
// sessions/[id]/regenerate). 120s timed the function out mid-call in prod on the
// first live click — 504, no arc, no wipe (2026-07-23). This locks that in.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/hyrox/generate', async (importOriginal) => ({ ...(await importOriginal()), generateArc: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { generateArc } = await import('@/lib/hyrox/generate')
const { POST, maxDuration } = await import('./route')

describe('POST /api/hyrox/blocks/[id]/regenerate', () => {
  it('provisions the full 300s timeout for arc generation (regression: 120s 504)', () => {
    expect(maxDuration).toBe(300)
  })
})

// ROUTEWRAP.R8 — through withAuth: signed in, then the block and the hyrox key
// at its studio (404, never 403), and no database text in an answer.
describe('POST /api/hyrox/blocks/[id]/regenerate — gate and errors', () => {
  const MINE = 'a1000000-0000-4000-8000-000000000001'
  const THEIRS = 'a1000000-0000-4000-8000-000000000002'
  const coach = (on) => person({ [LOC_A]: { role: 'owner', permissions: { approvals_hyrox_sessions: on } } }, LOC_A)
  const regenerate = (id = MINE) => POST(new Request(`http://localhost/api/hyrox/blocks/${id}/regenerate`, { method: 'POST' }), { params: Promise.resolve({ id }) })
  let db

  beforeEach(() => {
    vi.clearAllMocks()
    generateArc.mockResolvedValue({ ok: true, data: { weeks: [] } })
    db = createFakeDb({ tables: {
      locations: [{ id: LOC_A, name: 'Studio A', settings: {} }, { id: LOC_B, name: 'Studio B', settings: {} }],
      hyrox_blocks: [{ id: MINE, location_id: LOC_A, weeks: 12, sessions_per_week: 2 }, { id: THEIRS, location_id: LOC_B, weeks: 12, sessions_per_week: 2 }],
      hyrox_sessions: [{ id: 'a2000000-0000-4000-8000-000000000001', block_id: MINE, location_id: LOC_A, week_no: 1, slot: 1, phase: 'base', status: 'draft' }],
    } })
    createServerClient.mockReturnValue(db)
  })

  it('401 signed out, nothing generated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await regenerate()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(generateArc).not.toHaveBeenCalled()
  })

  it('404 for another studio’s block and without the key, nothing generated', async () => {
    getCurrentUser.mockResolvedValue(coach(true))
    expect((await regenerate(THEIRS)).status).toBe(404)
    getCurrentUser.mockResolvedValue(coach(false))
    expect((await regenerate()).status).toBe(404)
    expect(generateArc).not.toHaveBeenCalled()
  })

  it('regenerates the caller’s block, deleting its unpublished sessions', async () => {
    getCurrentUser.mockResolvedValue(coach(true))
    const res = await regenerate()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ regenerated: true, sessionsDeleted: 1 })
  })

  it('a failed delete answers a fixed 400, never the database text', async () => {
    getCurrentUser.mockResolvedValue(coach(true))
    db.errors.hyrox_sessions = { delete: { message: 'canceling statement due to lock timeout' } }
    const res = await regenerate()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not clear the old sessions. Nothing was changed. Try again.' })
  })
})
