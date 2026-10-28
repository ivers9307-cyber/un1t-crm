// UN1TWELCOME.2 — an enrolment started past step 1 (current_step_order: 1)
// on a one-step sequence completes without sending anything.
// Harness idiom copied from frequency-cap-scheduler.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('./steps.js', () => ({
  sendEmailStep: vi.fn(),
  sendWhatsappStep: vi.fn(),
  retiredSmsStep: vi.fn(),
  applyTagStep: vi.fn(),
  updateFieldStep: vi.fn(),
  webhookStep: vi.fn(),
  internalTaskStep: vi.fn(),
  processBranchStep: vi.fn(),
  movePipelineStageStep: vi.fn(),
  glofoxProvisionStep: vi.fn(),
}))

import { runSequences } from './scheduler.js'
import { createServerClient } from '@/lib/supabase'
import { sendEmailStep } from './steps.js'

function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
    rpc() { return Promise.resolve({ error: null }) },
  }
  return { db, statements }
}

const has = (state, method) => state.ops.some(o => o.method === method)

const enrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 1, error_count: 0, status: 'active', metadata: null,
}

// One due enrolment at current_step_order 1 on an active ONE-step sequence:
// there is no step_order 2, so nextStepForEnrollment finds nothing.
function route(state) {
  if (state.table === 'sequence_enrollments') {
    const first = state.ops[0]
    if (first.method === 'select') return { data: [enrollment] }
    if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: 'en-1' }] }
    return {}
  }
  if (state.table === 'email_sequences') {
    return { data: { id: 'seq-1', status: 'active', location_id: 'loc-1', goal_config: null, send_window: null } }
  }
  if (state.table === 'contacts') return { data: { id: 'c1', email: 'a@x.ie', location_id: 'loc-1' } }
  if (state.table === 'locations') return { data: { settings: {} } }
  if (state.table === 'sequence_steps') return { data: null }
  return {}
}

beforeEach(() => { vi.clearAllMocks() })

describe('runSequences — start step order', () => {
  it('completes an enrolment at step 1 of a one-step sequence without sending', async () => {
    const { db, statements } = makeDb(route)
    createServerClient.mockReturnValue(db)

    const stats = await runSequences()

    expect(stats.completed).toBe(1)
    expect(stats.sent).toBe(0)
    expect(sendEmailStep).not.toHaveBeenCalled()
    const done = statements.find(s =>
      s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' &&
      s.ops[0].args[0].status === 'completed')
    expect(done).toBeTruthy()
  })
})
