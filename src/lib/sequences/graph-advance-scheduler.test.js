// SEQ-TERMINAL — runSequences honouring config.next_step_order.
//
// The prod bug (seq 21983d6c, "New Lead – First Class Booking Nudge"):
// the runner advanced step_order+1 after EVERY non-branch step, so a
// branch arm that terminates (graph leaf) fell through into the other
// arm — already-booked leads got tagged first_booking_already_made and
// were then sent the book_first_visit template anyway. Graph-compiled
// steps now carry config.next_step_order ('end' | integer successor);
// the runner must complete on 'end', jump to an integer, and keep the
// legacy +1 behaviour when the marker is absent (linear-editor rows).

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
import { applyTagStep, processBranchStep, sendWhatsappStep } from './steps.js'

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
const eqArg = (state, col) => state.ops.find(o => o.method === 'eq' && o.args[0] === col)?.args[1]

// The cursor-advance update: a plain enrolment update carrying
// current_step_order (claim CAS carries lte; deferral/error updates
// don't touch the cursor).
function advanceUpdate(statements) {
  return statements.find(s =>
    s.table === 'sequence_enrollments' &&
    s.ops[0]?.method === 'update' &&
    !has(s, 'lte') &&
    'current_step_order' in s.ops[0].args[0]
  )
}

// Route for one due enrolment on an active sequence whose steps are
// served from the given rows (matched on the step_order eq filter).
function routeFor({ steps, enrollment }) {
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

// Enrolment sitting just before step 2 (the branch arm's step).
const enrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 1, error_count: 0, status: 'active', metadata: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("runSequences — config.next_step_order = 'end' (terminal arm)", () => {
  it('completes the enrolment instead of falling through to the next row', async () => {
    // The Anita shape: terminal yes-arm apply_tag at 2, no-arm whatsapp at 3.
    const steps = [
      { id: 'st-2', step_order: 2, step_type: 'apply_tag', config: { tag: 'first_booking_already_made', next_step_order: 'end' }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
      { id: 'st-3', step_order: 3, step_type: 'whatsapp', whatsapp_template_id: 'book_first_visit', config: { next_step_order: 'end' }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
    ]
    const { db, statements } = makeDb(routeFor({ steps, enrollment }))
    createServerClient.mockReturnValue(db)
    applyTagStep.mockResolvedValue(undefined)

    const stats = await runSequences()

    expect(applyTagStep).toHaveBeenCalledTimes(1)
    expect(sendWhatsappStep).not.toHaveBeenCalled()
    expect(stats.completed).toBe(1)
    expect(stats.errored).toBe(0)

    const adv = advanceUpdate(statements)
    expect(adv).toBeTruthy()
    const payload = adv.ops[0].args[0]
    expect(payload.status).toBe('completed')
    expect(payload.next_step_at).toBeNull()
    // Cursor may not point past the executed step — a stray reactivation
    // must not land on the no-arm row.
    expect(payload.current_step_order).toBe(2)

    // Completion is counted on the sequence.
    const rpc = statements.find(s => s.table === '__rpc__')
    expect(rpc.ops[0].args[0]).toBe('increment_sequence_completed')
  })
})

describe('runSequences — integer next_step_order (convergent arms)', () => {
  it('jumps over the other arm to the join step', async () => {
    const steps = [
      { id: 'st-2', step_order: 2, step_type: 'apply_tag', config: { tag: 'went', next_step_order: 4 }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
      { id: 'st-3', step_order: 3, step_type: 'whatsapp', whatsapp_template_id: 'come_back', config: { next_step_order: 4 }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
      { id: 'st-4', step_order: 4, step_type: 'email', subject: 'weekly', config: { next_step_order: 'end' }, delay_days: 0, delay_hours: 2, delay_minutes: 0 },
    ]
    const { db, statements } = makeDb(routeFor({ steps, enrollment }))
    createServerClient.mockReturnValue(db)
    applyTagStep.mockResolvedValue(undefined)
    const now = new Date('2026-07-15T10:00:00Z')

    const stats = await runSequences({ now })

    expect(stats.sent).toBe(1)
    expect(stats.completed).toBe(0)
    const adv = advanceUpdate(statements)
    const payload = adv.ops[0].args[0]
    // Cursor lands on followingOrder - 1 = 3 so the next tick runs step 4.
    expect(payload.current_step_order).toBe(3)
    expect(payload.status).toBe('active')
    // next fire honours the JOIN step's delay (2h), proving the delay
    // lookup queried step 4, not step 3.
    expect(payload.next_step_at).toBe('2026-07-15T12:00:00.000Z')
  })

  it('a self-pointing marker takes the error path instead of re-running the step forever', async () => {
    const steps = [
      { id: 'st-2', step_order: 2, step_type: 'apply_tag', config: { tag: 'x', next_step_order: 2 }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
    ]
    const { db, statements } = makeDb(routeFor({ steps, enrollment }))
    createServerClient.mockReturnValue(db)
    applyTagStep.mockResolvedValue(undefined)

    const stats = await runSequences()

    expect(stats.errored).toBe(1)
    const errUpdate = statements.find(s =>
      s.table === 'sequence_enrollments' &&
      s.ops[0]?.method === 'update' &&
      typeof s.ops[0].args[0].last_error === 'string' &&
      s.ops[0].args[0].last_error.includes('next_step_order')
    )
    expect(errUpdate).toBeTruthy()
  })
})

describe('runSequences — legacy steps without a marker', () => {
  it('advances step_order + 1 exactly as before', async () => {
    const steps = [
      { id: 'st-2', step_order: 2, step_type: 'apply_tag', config: { tag: 'x' }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
      { id: 'st-3', step_order: 3, step_type: 'sms', sms_body: 'hi', delay_days: 0, delay_hours: 0, delay_minutes: 0 },
    ]
    const { db, statements } = makeDb(routeFor({ steps, enrollment }))
    createServerClient.mockReturnValue(db)
    applyTagStep.mockResolvedValue(undefined)

    const stats = await runSequences()

    expect(stats.sent).toBe(1)
    const payload = advanceUpdate(statements).ops[0].args[0]
    expect(payload.current_step_order).toBe(2)
    expect(payload.status).toBe('active')
  })

  it('a legacy final step still completes via the missing-following-row path', async () => {
    const steps = [
      { id: 'st-2', step_order: 2, step_type: 'apply_tag', config: { tag: 'x' }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
    ]
    const { db, statements } = makeDb(routeFor({ steps, enrollment }))
    createServerClient.mockReturnValue(db)
    applyTagStep.mockResolvedValue(undefined)

    const stats = await runSequences()

    expect(stats.completed).toBe(1)
    const payload = advanceUpdate(statements).ops[0].args[0]
    expect(payload.status).toBe('completed')
    expect(payload.next_step_at).toBeNull()
  })
})

describe('runSequences — branch steps', () => {
  it('the branch target from processBranchStep still drives the jump', async () => {
    const steps = [
      { id: 'st-2', step_order: 2, step_type: 'branch', config: { predicate: { type: 'has_tag', tag: 't' }, then_step_order: 5, else_step_order: 3 }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
      { id: 'st-5', step_order: 5, step_type: 'sms', sms_body: 'yes arm', config: { next_step_order: 'end' }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
    ]
    const { db, statements } = makeDb(routeFor({ steps, enrollment }))
    createServerClient.mockReturnValue(db)
    processBranchStep.mockResolvedValue(5)

    const stats = await runSequences()

    expect(stats.sent).toBe(1)
    const payload = advanceUpdate(statements).ops[0].args[0]
    expect(payload.current_step_order).toBe(4)
    expect(payload.status).toBe('active')
  })
})
