// PIPEBUILD.5n — the flow agent writes trigger_type / trigger_config, so it
// refuses a retired follow-up sequence exactly as PUT /api/sequences/[id] does.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: () => null,
}))
vi.mock('@/lib/sequence-access', () => ({
  canBuildSequencesAt: () => true,
  canBuildSequencesSomewhere: () => true,
  sequencePermissionRequired: () => new Response('{}', { status: 403 }),
  sequenceNotFound: () => new Response('{}', { status: 404 }),
}))
vi.mock('@/lib/followup-owned-sequences', async (importOriginal) => ({ ...(await importOriginal()), refuseIfFollowupOwned: async () => null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/sequences/agent/run', () => ({ runFlowAgent: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runFlowAgent } from '@/lib/sequences/agent/run'

const ID = 'a0000000-0000-0000-0000-000000000001'
const LOC = 'c0000000-0000-0000-0000-000000000003'

function mockDb(row) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }))
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: row, error: null })) })) })),
      update,
    })),
  }
  return { db, update }
}
const req = () => new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'welcome them' }) })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1' })
  process.env.ANTHROPIC_API_KEY = 'test'
})

describe('POST /api/sequences/[id]/graph/agent', () => {
  it('409s followup_retired for a retired follow-up sequence and writes nothing', async () => {
    const { db, update } = mockDb({
      location_id: LOC, name: 'Old', status: 'archived',
      trigger_type: 'pipeline_stage_change', trigger_config: { to_status: 'o_reset_39_done' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), { params: Promise.resolve({ id: ID }) })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('followup_retired')
    expect(runFlowAgent).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('still builds for an ordinary sequence', async () => {
    const { db, update } = mockDb({ location_id: LOC, name: 'Mine', status: 'draft', trigger_type: 'manual', trigger_config: {} })
    createServerClient.mockReturnValue(db)
    runFlowAgent.mockResolvedValue({ ok: true, graph: { trigger: { type: 'manual', config: {} } }, validation: {}, name: 'X' })
    const res = await POST(req(), { params: Promise.resolve({ id: ID }) })
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalled()
  })
})
