// SEQCOUNTERS.1 — /stats is the Performance panel's source for enrolment
// counts. A failed enrolments read used to answer total 0 / active 0 (a
// failed read shown as an empty answer); it is now a logged 500, and the
// panel keeps its last good numbers (AutomationPerformance ignores a
// non-success). Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/select-all', () => ({ selectAll: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { selectAll } from '@/lib/select-all'
import { logError } from '@/lib/log'
import { MASTER, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

const SEQ = '5e000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: SEQ }) }
const db = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { id: SEQ, location_id: LOC_A }, error: null }) }
    return chain
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('GET /api/sequences/[id]/stats (SEQCOUNTERS.1)', () => {
  it('counts enrolments from the rows', async () => {
    selectAll
      .mockResolvedValueOnce([]) // email_sends
      .mockResolvedValueOnce([{ status: 'completed', exit_reason: null }, { status: 'exited', exit_reason: 'goal_met' }, { status: 'active', exit_reason: null }])
    const body = await (await GET(new Request('http://localhost/x'), props)).json()
    expect(body.data.enrolments).toEqual({ total: 3, active: 1, completed: 1, exited: 1, paused: 0 })
  })

  it('a failed enrolments read is a logged 500, never zeros', async () => {
    selectAll
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: '57014' }))
    const res = await GET(new Request('http://localhost/x'), props)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load enrolments' })
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringMatching(/stats: enrolments read failed/), expect.objectContaining({ sequenceId: SEQ }))
  })
})
