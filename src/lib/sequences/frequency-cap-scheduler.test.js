// FREQ-CAP.1 — runSequences handling of FrequencyCapDeferral.
//
// The dangerous surface is the scheduler's catch: a deferral must move
// next_step_at to the window-clear time WITHOUT incrementing
// error_count, WITHOUT touching status, and WITHOUT advancing the
// cursor — and it must be counted as `deferred`, not `errored`. If the
// deferral ever fell through to the generic error path, five capped
// ticks would auto-PAUSE the enrolment (the exact wedge recordStepSkip
// was built to avoid); if it advanced the cursor, the step would be
// silently SKIPPED instead of deferred.

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
import { sendEmailStep } from './steps.js'
import { FrequencyCapDeferral } from '@/lib/frequency-cap'

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

const enrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 0, error_count: 2, status: 'active', metadata: null,
}

// Standard route for one due enrolment on an active sequence with an
// email step next, at a location with the cap ENABLED.
function routeFor({ capEnabled = true } = {}) {
  return (state) => {
    if (state.table === 'sequence_enrollments') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: [enrollment] }
      // The claim CAS carries the `lte` predicate; grant it.
      if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: 'en-1' }] }
      return {}
    }
    if (state.table === 'email_sequences') {
      return { data: { id: 'seq-1', status: 'active', location_id: 'loc-1', goal_config: null, send_window: null } }
    }
    if (state.table === 'contacts') {
      return { data: { id: 'c1', email: 'a@x.ie', location_id: 'loc-1' } }
    }
    if (state.table === 'locations') {
      return { data: { settings: { comms_frequency_cap: { enabled: capEnabled, min_hours_between: 24 } } } }
    }
    if (state.table === 'sequence_steps') {
      // nextStepForEnrollment (select *) and the following-step delay lookup.
      return { data: { id: 'st-1', step_order: 1, step_type: 'email', delay_days: 0, delay_hours: 0, delay_minutes: 0 } }
    }
    return {}
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runSequences — FrequencyCapDeferral handling', () => {
  it('defers: next_step_at → deferUntil, error_count/status/cursor untouched', async () => {
    const deferUntil = new Date(Date.now() + 6 * 60 * 60_000).toISOString()
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockRejectedValue(new FrequencyCapDeferral(deferUntil))

    const stats = await runSequences()

    expect(stats.deferred).toBe(1)
    expect(stats.errored).toBe(0)
    expect(stats.paused).toBe(0)
    expect(stats.sent).toBe(0)

    // The deferral update: plain enrolment update (no lte claim predicate).
    const deferUpdate = statements.find(s =>
      s.table === 'sequence_enrollments' &&
      s.ops[0]?.method === 'update' &&
      !has(s, 'lte') &&
      s.ops[0].args[0].next_step_at === deferUntil
    )
    expect(deferUpdate).toBeTruthy()
    const payload = deferUpdate.ops[0].args[0]
    expect(payload).not.toHaveProperty('error_count')
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('current_step_order')
    expect(payload).not.toHaveProperty('last_error')
    expect(payload.last_processed_at).toEqual(expect.any(String))
  })

  it('the email handler receives the location cap setting via ctx.frequencyCap', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockResolvedValue('pm-1')

    await runSequences()

    expect(sendEmailStep).toHaveBeenCalledTimes(1)
    const ctx = sendEmailStep.mock.calls[0][1]
    expect(ctx.frequencyCap).toEqual({ enabled: true, minHoursBetween: 24 })
  })

  it('a real handler error still takes the error path (error_count + backoff)', async () => {
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockRejectedValue(new Error('SMTP exploded'))

    const stats = await runSequences()

    expect(stats.errored).toBe(1)
    expect(stats.deferred).toBe(0)
    const errUpdate = statements.find(s =>
      s.table === 'sequence_enrollments' &&
      s.ops[0]?.method === 'update' &&
      s.ops[0].args[0].last_error === 'SMTP exploded'
    )
    expect(errUpdate).toBeTruthy()
    expect(errUpdate.ops[0].args[0].error_count).toBe(3)
  })
})
