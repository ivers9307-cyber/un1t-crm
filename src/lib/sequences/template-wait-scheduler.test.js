// PIPEBUILD.1b — runSequences handling of TemplateNotApprovedDeferral: a
// pending template waits (no error_count / status change), and a wait past
// 48 h exits the enrolment instead of sending late.

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
import { sendWhatsappStep } from './steps.js'
import { TemplateNotApprovedDeferral, templateStamp } from './template-wait.js'

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
      return { data: { id: 'st-1', step_order: 1, step_type: 'whatsapp', whatsapp_template_id: 'tpl-1', delay_days: 0, delay_hours: 0, delay_minutes: 0 } }
    }
    return {}
  }
}

const baseEnrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 0, error_count: 2, status: 'active', metadata: null,
}
const deferral = (status = 'PENDING') =>
  new TemplateNotApprovedDeferral({ templateId: 'tpl-1', templateName: 'welcome', status, stepOrder: 1 })

const plainUpdate = (statements) => statements.find(s =>
  s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && !has(s, 'lte'))

beforeEach(() => { vi.clearAllMocks() })

describe('runSequences — TemplateNotApprovedDeferral handling', () => {
  it('deferralDoesNotCountAnError', async () => {
    const { db, statements } = makeDb(routeFor(baseEnrollment))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockRejectedValue(deferral())
    const before = Date.now()

    const stats = await runSequences()

    expect(stats.deferred).toBe(1)
    expect(stats.errored).toBe(0)
    expect(stats.paused).toBe(0)
    const payload = plainUpdate(statements).ops[0].args[0]
    expect(payload).not.toHaveProperty('error_count')
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('current_step_order')
    const at = Date.parse(payload.next_step_at)
    expect(Math.abs(at - (before + 60 * 60_000))).toBeLessThan(60_000)
    expect(payload.metadata.template_wait).toMatchObject({ template_id: 'tpl-1', step_order: 1 })
    expect(payload.last_error).toBe(`${templateStamp('tpl-1')}waiting for Meta to approve "welcome" (PENDING)`)
  })

  it('pausedByMetaDefersThenExits', async () => {
    const since = new Date(Date.now() - 49 * 3_600_000).toISOString()
    const enrollment = { ...baseEnrollment, metadata: { template_wait: { template_id: 'tpl-1', step_order: 1, since } } }
    const { db, statements } = makeDb(routeFor(enrollment))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockRejectedValue(deferral('PAUSED'))

    const stats = await runSequences()

    expect(stats.exited_stale).toBe(1)
    expect(stats.deferred).toBe(0)
    expect(stats.errored).toBe(0)
    const payload = plainUpdate(statements).ops[0].args[0]
    expect(payload).toMatchObject({ status: 'exited', exit_reason: 'stale_template_wait', next_step_at: null })
    expect(payload.exited_at).toEqual(expect.any(String))
  })

  it('advanceClearsWaitRecord', async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString()
    const enrollment = { ...baseEnrollment, metadata: { test: true, template_wait: { template_id: 'tpl-1', step_order: 1, since } } }
    const { db, statements } = makeDb(routeFor(enrollment))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockResolvedValue('send-uuid')

    const stats = await runSequences()

    expect(stats.sent).toBe(1)
    const advance = statements.find(s =>
      s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && has(s, 'select') &&
      s.ops[0].args[0].last_step_send_id === 'send-uuid')
    expect(advance).toBeTruthy()
    const payload = advance.ops[0].args[0]
    expect(payload.metadata).toEqual({ test: true })
  })
})
