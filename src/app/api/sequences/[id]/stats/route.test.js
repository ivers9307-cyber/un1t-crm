// SEQCOUNTERS.1 — /stats is the Performance panel's source for enrolment
// counts. A failed enrolments read used to answer total 0 / active 0 (a
// failed read shown as an empty answer). It now answers enrolments: null
// with a warning, logged, and keeps the per-step results (they come from a
// different read that succeeded); the panel shows a notice in place of the
// funnel numbers. A failed SENDS read is still a 500. Fictional values only.
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

  it('a failed enrolments read is logged and answered as unknown counts, never zeros, and keeps the per-step results', async () => {
    selectAll
      .mockResolvedValueOnce([{ sequence_step_id: 'st-1', status: 'sent', opened_at: 'T', clicked_at: null, bounced_at: null, complained_at: null }])
      .mockRejectedValueOnce(new Error('timeout'))
    const res = await GET(new Request('http://localhost/x'), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.warning).toBe('Enrolment counts could not be loaded')
    expect(body.data.enrolments).toBeNull()
    expect(body.data.exit_reasons).toBeNull()
    expect(body.data.per_step).toEqual({ 'st-1': { sent: 1, opened: 1, clicked: 0, bounced: 0, complained: 0, failed: 0 } })
    // selectAll rethrows new Error(message), so there is no PostgREST code to
    // log; the message is never logged or returned.
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringMatching(/stats: enrolments read failed/), { sequenceId: SEQ })
  })

  it('a failed sends read is still a 500', async () => {
    selectAll.mockRejectedValueOnce(new Error('timeout'))
    const res = await GET(new Request('http://localhost/x'), props)
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
