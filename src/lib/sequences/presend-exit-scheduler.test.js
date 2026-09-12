// PRESEND.1 — the runner must not resurrect a run that was exited MID-STEP.
//
// The pre-send gate exits a dunning enrolment (status 'exited') the moment it
// learns the invoice has been paid, and the step handler then returns null —
// which the runner treats exactly like a skipped step: one cursor-advance
// update. That update writes `status: 'active'` whenever a following step
// exists, so without a guard it would flip the just-exited run straight back
// to active and the NEXT reminder would go out anyway — the precise outcome
// the gate exists to prevent, and invisible in every log.
//
// The advance is therefore conditional on the enrolment still being active.
// It is a CAS, the same discipline the claim uses: the row was claimed with
// status='active', so the only way the predicate misses is that something
// inside the step deliberately ended the run.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('./steps.js', () => ({
  sendEmailStep: vi.fn(),
  sendWhatsappStep: vi.fn(),
  sendSmsStep: vi.fn(),
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
import { sendWhatsappStep } from './steps.js'

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
const eqArg = (state, col) => state.ops.find(o => o.method === 'eq' && o.args[0] === col)?.args[1]

function advanceUpdate(statements) {
  return statements.find(s =>
    s.table === 'sequence_enrollments' &&
    s.ops[0]?.method === 'update' &&
    !has(s, 'lte') &&
    'current_step_order' in s.ops[0].args[0]
  )
}

const enrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 1, error_count: 0, status: 'active',
  source_type: 'invoice_past_due', metadata: { payment: { invoice_id: 'inv-1' } },
}

// Two remaining steps, so the advance would otherwise write status 'active'.
const steps = [
  { id: 'st-2', step_order: 2, step_type: 'whatsapp', whatsapp_template_id: 'tpl', config: {}, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
  { id: 'st-3', step_order: 3, step_type: 'email', subject: 'day 7', config: {}, delay_days: 4, delay_hours: 0, delay_minutes: 0 },
]

function routeFor() {
  return (state) => {
    if (state.table === 'sequence_enrollments') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: [enrollment] }
      if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: enrollment.id }] }
      return {}
    }
    if (state.table === 'email_sequences') {
      return { data: { id: 'seq-1', status: 'active', location_id: 'loc-1', goal_config: null, send_window: null } }
    }
    if (state.table === 'contacts') return { data: { id: 'c1', location_id: 'loc-1' } }
    if (state.table === 'locations') return { data: { settings: {} } }
    if (state.table === 'sequence_steps') {
      const order = eqArg(state, 'step_order')
      return { data: steps.find(s => s.step_order === order) ?? null }
    }
    return {}
  }
}

beforeEach(() => vi.clearAllMocks())

describe('runSequences — the cursor advance cannot revive an exited run', () => {
  it('guards the advance on status=active so a mid-step exit sticks', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    // The gate's shape: it exits the enrolment itself, then the handler
    // records the skip and resolves null.
    sendWhatsappStep.mockResolvedValue(null)

    await runSequences()

    const adv = advanceUpdate(statements)
    expect(adv, 'no cursor-advance update was issued').toBeTruthy()
    // It still tries to advance (a plain skipped step must keep moving) …
    expect(adv.ops[0].args[0].status).toBe('active')
    // … but only for a row that is STILL active. Without this predicate the
    // update matches the exited row by id and flips it back.
    expect(eqArg(adv, 'status'), 'advance is not guarded on status=active').toBe('active')
    expect(eqArg(adv, 'id')).toBe('en-1')
  })
})
