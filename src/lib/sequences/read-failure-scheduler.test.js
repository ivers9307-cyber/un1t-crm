// SEQREAD.1 (October audit A13) + SEQERRPATH.1 — a failed read is never an
// answer: it neither completes nor exits an enrolment, and the error path never
// writes over a pause or exit staff made while a step ran.
// Harness idiom copied from start-step-scheduler.test.js.

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
  current_step_order: 0, error_count: 0, status: 'active', metadata: { test: true },
}
const DOWN = { data: null, error: { message: 'connection reset' } }

function routeWith({ sequence, contact, step, errorWrite } = {}) {
  return (state) => {
    if (state.table === 'sequence_enrollments') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: [enrollment] }
      if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: 'en-1' }] }
      if (first.method === 'update' && 'error_count' in first.args[0]) return errorWrite ?? { data: [{ id: 'en-1' }] }
      return {}
    }
    if (state.table === 'email_sequences') {
      return sequence ?? { data: { id: 'seq-1', status: 'active', location_id: 'loc-1', goal_config: null, send_window: null } }
    }
    if (state.table === 'contacts') return contact ?? { data: { id: 'c1', email: 'a@x.ie', location_id: 'loc-1' } }
    if (state.table === 'locations') return { data: { settings: {}, timezone: 'Europe/Dublin' } }
    if (state.table === 'sequence_steps') return step ?? { data: { id: 'st-1', step_order: 1, step_type: 'email', config: {} } }
    return {}
  }
}
const statusWrites = (statements) => statements.filter((s) =>
  s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && 'status' in s.ops[0].args[0])

beforeEach(() => { vi.clearAllMocks() })

describe('runSequences — a failed read is not an answer (A13)', () => {
  it('an unreadable next step leaves the enrolment as it is, never completed', async () => {
    const { db, statements } = makeDb(routeWith({ step: DOWN }))
    createServerClient.mockReturnValue(db)
    const stats = await runSequences()
    expect(stats.completed).toBe(0)
    expect(stats.read_unavailable).toBe(1)
    expect(statusWrites(statements)).toHaveLength(0)
  })

  it('a step that is really missing still completes the enrolment', async () => {
    const { db } = makeDb(routeWith({ step: { data: null, error: null } }))
    createServerClient.mockReturnValue(db)
    expect((await runSequences()).completed).toBe(1)
  })

  it('an unreadable sequence or contact never exits the enrolment as deleted', async () => {
    for (const r of [{ sequence: DOWN }, { contact: DOWN }]) {
      const { db, statements } = makeDb(routeWith(r))
      createServerClient.mockReturnValue(db)
      const stats = await runSequences()
      expect(stats.read_unavailable).toBe(1)
      expect(statusWrites(statements)).toHaveLength(0)
    }
  })

  it('a contact that is really gone still exits', async () => {
    const { db, statements } = makeDb(routeWith({ contact: { data: null, error: null } }))
    createServerClient.mockReturnValue(db)
    await runSequences()
    const exit = statusWrites(statements).find((s) => s.ops[0].args[0].status === 'exited')
    expect(exit.ops[0].args[0].last_error).toBe('Contact deleted')
  })
})

describe('runSequences — the error path keeps a staff pause or exit', () => {
  it('writes the error only to a still-active enrolment', async () => {
    sendEmailStep.mockRejectedValue(new Error('provider down'))
    const { db, statements } = makeDb(routeWith())
    createServerClient.mockReturnValue(db)
    const stats = await runSequences()
    expect(stats.errored).toBe(1)
    const write = statements.find((s) => s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && 'error_count' in s.ops[0].args[0])
    expect(write.ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
  })

  it('an enrolment paused meanwhile is not counted as paused by the runner', async () => {
    sendEmailStep.mockRejectedValue(new Error('provider down'))
    const paused = { ...enrollment, error_count: 99 }
    const { db } = makeDb((state) => {
      if (state.table === 'sequence_enrollments' && state.ops[0].method === 'select') return { data: [paused] }
      return routeWith({ errorWrite: { data: [], error: null } })(state)
    })
    createServerClient.mockReturnValue(db)
    const stats = await runSequences()
    expect(stats.paused).toBe(0)
  })
})
