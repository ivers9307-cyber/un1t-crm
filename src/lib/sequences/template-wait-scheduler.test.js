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
    // Midday Dublin: outside quiet hours, so the retry is exactly +1 h.
    const now = new Date('2026-11-06T12:00:00.000Z')

    const stats = await runSequences({ now })

    expect(stats.deferred).toBe(1)
    expect(stats.errored).toBe(0)
    expect(stats.paused).toBe(0)
    const payload = plainUpdate(statements).ops[0].args[0]
    expect(payload).not.toHaveProperty('error_count')
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('current_step_order')
    expect(payload.next_step_at).toBe('2026-11-06T13:00:00.000Z')
    expect(plainUpdate(statements).ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
    expect(payload.metadata.template_wait).toMatchObject({ template_id: 'tpl-1', step_order: 1 })
    expect(payload.last_error).toBe(`${templateStamp('tpl-1')}waiting for Meta to approve "welcome" (PENDING)`)
  })

  it('pausedByMetaDefersThenExits', async () => {
    const now = new Date('2026-11-06T12:00:00.000Z')
    const since = new Date(now.getTime() - 49 * 3_600_000).toISOString()
    const enrollment = { ...baseEnrollment, metadata: { template_wait: { template_id: 'tpl-1', step_order: 1, since } } }
    const { db, statements } = makeDb(routeFor(enrollment))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockRejectedValue(deferral('PAUSED'))

    const stats = await runSequences({ now })

    expect(stats.exited_stale).toBe(1)
    expect(stats.deferred).toBe(0)
    expect(stats.errored).toBe(0)
    const payload = plainUpdate(statements).ops[0].args[0]
    expect(payload).toMatchObject({ status: 'exited', exit_reason: 'stale_template_wait', next_step_at: null })
    expect(payload.exited_at).toEqual(expect.any(String))
    expect(plainUpdate(statements).ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
  })

  // PIPEBUILD.1g — the retry is a fire time: the one that finds the template
  // APPROVED sends on the spot, so it must respect the studio's quiet hours.
  it('deferralInQuietHoursRetriesAtTheEndOfQuietHours', async () => {
    const { db, statements } = makeDb(routeFor(baseEnrollment))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockRejectedValue(deferral())
    // 22:00 Europe/Dublin (GMT in November); default quiet hours 21:00-08:00.
    const now = new Date('2026-11-06T22:00:00.000Z')

    const stats = await runSequences({ now })

    expect(stats.deferred).toBe(1)
    const update = plainUpdate(statements)
    expect(update.ops[0].args[0].next_step_at).toBe('2026-11-07T08:00:00.000Z')
    expect(update.ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
  })

  it('deferralRespectsTheSequenceSendWindowOverQuietHours', async () => {
    const route = routeFor(baseEnrollment)
    const { db, statements } = makeDb((state) => state.table === 'email_sequences'
      ? { data: { id: 'seq-1', status: 'active', location_id: 'loc-1', goal_config: null, send_window: { start_hour: 10, end_hour: 18 } } }
      : route(state))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockRejectedValue(deferral())
    const now = new Date('2026-11-06T22:00:00.000Z')

    await runSequences({ now })

    // The window (10:00-18:00) wins outright: 10:00 Dublin, not 08:00.
    expect(plainUpdate(statements).ops[0].args[0].next_step_at).toBe('2026-11-07T10:00:00.000Z')
  })

  it('testEnrolmentDeferralIsNotClamped', async () => {
    const enrollment = { ...baseEnrollment, metadata: { test: true } }
    const { db, statements } = makeDb(routeFor(enrollment))
    createServerClient.mockReturnValue(db)
    sendWhatsappStep.mockRejectedValue(deferral())
    const now = new Date('2026-11-06T22:00:00.000Z')

    await runSequences({ now })

    expect(plainUpdate(statements).ops[0].args[0].next_step_at).toBe('2026-11-06T23:00:00.000Z')
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
