// SEQUNDELIVERABLE.1 — audit 2026-11-15 item 13: a Postmark 406 (inactive
// recipient) used to count as an ordinary error, retry four times and leave
// the enrolment paused for good (90 live from 14 Oct). It now exits at once
// with exit_reason 'undeliverable'; other errors still back off and pause.

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
import { isUndeliverableRecipient, MAX_ERRORS } from './scheduler.js'

// Chainable recorder db (campaign-sender.test.js idiom).
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
    rpc(...args) {
      statements.push({ table: '__rpc__', ops: [{ method: 'rpc', args }] })
      return Promise.resolve({ error: null })
    },
  }
  return { db, statements }
}

const has = (state, method) => state.ops.some(o => o.method === method)



function routeFor(enrollment) {
  return (state) => {
    if (state.table === 'sequence_enrollments') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: [enrollment] }
      if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: 'en-1' }] }
      if (first.method === 'update') return { data: [{ id: 'en-1' }] }
      return {}
    }
    if (state.table === 'email_sequences') {
      return { data: { id: 'seq-1', status: 'active', location_id: 'loc-1', goal_config: null, send_window: null } }
    }
    if (state.table === 'contacts') {
      return { data: { id: 'c1', email: 'a@x.ie', location_id: 'loc-1' } }
    }
    if (state.table === 'locations') return { data: { settings: {} } }
    if (state.table === 'sequence_steps') {
      return { data: { id: 'st-1', step_order: 1, step_type: 'email', subject: 'Hi', delay_days: 0, delay_hours: 0, delay_minutes: 0 } }
    }
    return {}
  }
}

const baseEnrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 0, error_count: 0, status: 'active', metadata: null,
}
const postmarkError = (code, message) => Object.assign(new Error(message), { errorCode: code, httpStatus: 422 })
const plainUpdate = (statements) => statements.find(s =>
  s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && !has(s, 'lte'))
const now = new Date('2026-11-16T12:00:00.000Z')

beforeEach(() => { vi.clearAllMocks() })

describe('isUndeliverableRecipient', () => {
  it('is Postmark 406 only', () => {
    expect(isUndeliverableRecipient(postmarkError(406, 'inactive'))).toBe(true)
    for (const code of [300, 400, 429, 500, null]) expect(isUndeliverableRecipient(postmarkError(code, 'x'))).toBe(false)
    expect(isUndeliverableRecipient(new Error('plain'))).toBe(false)
    expect(isUndeliverableRecipient(null)).toBe(false)
  })
})

describe('runSequences — an inactive recipient exits instead of pausing', () => {
  it('a 406 exits the enrolment as undeliverable, with no error count or pause', async () => {
    const { db, statements } = makeDb(routeFor(baseEnrollment))
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockRejectedValue(postmarkError(406, 'You tried to send to recipient(s) that have been marked as inactive.'))

    const stats = await runSequences({ now })

    expect(stats.exited_undeliverable).toBe(1)
    expect(stats.errored).toBe(0)
    expect(stats.paused).toBe(0)
    const payload = plainUpdate(statements).ops[0].args[0]
    expect(payload).toMatchObject({ status: 'exited', exit_reason: 'undeliverable', next_step_at: null })
    expect(payload).not.toHaveProperty('error_count')
    expect(payload.last_error).toMatch(/inactive/)
    expect(plainUpdate(statements).ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
  })

  it('any other send error still counts, backs off and pauses at the cap', async () => {
    const enrollment = { ...baseEnrollment, error_count: MAX_ERRORS - 1 }
    const { db, statements } = makeDb(routeFor(enrollment))
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockRejectedValue(postmarkError(300, 'Invalid email request'))

    const stats = await runSequences({ now })

    expect(stats.paused).toBe(1)
    expect(plainUpdate(statements).ops[0].args[0]).toMatchObject({ status: 'paused', error_count: MAX_ERRORS })
  })
})
