// Unit tests for the sequence scheduler helpers.
//
// runSequences itself is integration-shaped (DB cursor, fan-out to
// step handlers) so it's covered indirectly by sequences-sms /
// sequences-branch / sequences-cooldown E2E suites. Here we test the
// pure helpers that make it correct: nextStepDelayMs, clampToSendWindow,
// isGoalMet, plus setEnrollmentStatus's update shape.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing the module so createServerClient is
// a Vitest mock when scheduler.js loads.
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

// SEQEXIT.1 — the runSequences-level tests at the bottom of this file
// drive the per-step audience re-check, so the step handlers, the
// evaluator and the logger all have to be controllable.
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
vi.mock('./audience.js', () => ({
  evaluateSequenceAudience: vi.fn(),
  contactMatchesSequenceAudience: vi.fn(),
}))
vi.mock('@/lib/log', () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import {
  nextStepDelayMs,
  clampToSendWindow,
  isGoalMet,
  setEnrollmentStatus,
  MAX_ERRORS,
  PROCESS_BATCH_SIZE,
} from './scheduler.js'
import { createServerClient } from '@/lib/supabase'

// ── nextStepDelayMs ──────────────────────────────────────────────

describe('nextStepDelayMs', () => {
  it('returns 0 for null/undefined', () => {
    expect(nextStepDelayMs(null)).toBe(0)
    expect(nextStepDelayMs(undefined)).toBe(0)
  })

  it('returns 0 for a step with no delay fields', () => {
    expect(nextStepDelayMs({})).toBe(0)
  })

  it('sums days+hours+minutes correctly', () => {
    // 1 day + 2 hours + 30 minutes = 26.5 hours = 95_400_000 ms
    expect(nextStepDelayMs({ delay_days: 1, delay_hours: 2, delay_minutes: 30 })).toBe(
      95_400_000,
    )
  })

  it('treats nullable fields as 0', () => {
    expect(nextStepDelayMs({ delay_days: null, delay_hours: 1, delay_minutes: null })).toBe(
      60 * 60_000,
    )
  })

  it('returns 0 for negative or non-finite results', () => {
    expect(nextStepDelayMs({ delay_days: -1 })).toBe(0)
    expect(nextStepDelayMs({ delay_hours: NaN })).toBe(0)
  })
})

// ── clampToSendWindow ────────────────────────────────────────────
//
// Window times are interpreted in Europe/Dublin. May 2026 is BST
// (UTC+1), so a UTC instant of 09:00 reads as 10:00 local.

describe('clampToSendWindow', () => {
  it('returns the same Date if no window', () => {
    const d = new Date('2026-05-15T10:00:00Z')
    expect(clampToSendWindow(d, null).getTime()).toBe(d.getTime())
  })

  it('returns the same Date if window has no constraints', () => {
    const d = new Date('2026-05-15T10:00:00Z')
    const out = clampToSendWindow(d, { start_hour: null, end_hour: null, skip_days: [] })
    expect(out.getTime()).toBe(d.getTime())
  })

  it('returns the same Date if already inside the window', () => {
    // 14:00 UTC = 15:00 BST → inside 9-17 local window
    const d = new Date('2026-05-15T14:00:00Z')
    const out = clampToSendWindow(d, { start_hour: 9, end_hour: 17, skip_days: [] })
    expect(out.getTime()).toBe(d.getTime())
  })

  it('pushes forward when before start_hour', () => {
    // 04:00 UTC = 05:00 BST → before 9am local
    const d = new Date('2026-05-15T04:00:00Z')
    const out = clampToSendWindow(d, { start_hour: 9, end_hour: 17, skip_days: [] })
    // Should land at 9am local = 8am UTC same day (May = BST = +1)
    expect(out.toISOString()).toBe('2026-05-15T08:00:00.000Z')
  })

  it('pushes forward when after end_hour (rolls into next day window)', () => {
    // 22:00 UTC May 15 = 23:00 BST → after 17:00 cutoff → next day 9am local
    const d = new Date('2026-05-15T22:00:00Z')
    const out = clampToSendWindow(d, { start_hour: 9, end_hour: 17, skip_days: [] })
    // 9am BST May 16 = 8am UTC May 16
    expect(out.toISOString()).toBe('2026-05-16T08:00:00.000Z')
  })

  it('skips Sundays when skip_days includes 0', () => {
    // Sun May 17 2026, 14:00 UTC = 15:00 BST → skipped
    const d = new Date('2026-05-17T14:00:00Z')
    const out = clampToSendWindow(d, { start_hour: 9, end_hour: 17, skip_days: [0] })
    // First Mon May 18 9am BST = 8am UTC
    expect(out.toISOString()).toBe('2026-05-18T08:00:00.000Z')
  })

  it('skips Sat AND Sun when skip_days = [0,6]', () => {
    // Sat May 16 12:00 UTC → skipped
    const d = new Date('2026-05-16T12:00:00Z')
    const out = clampToSendWindow(d, { start_hour: 9, end_hour: 17, skip_days: [0, 6] })
    // Mon May 18 9am BST = 8am UTC
    expect(out.toISOString()).toBe('2026-05-18T08:00:00.000Z')
  })

  it('falls back gracefully if window is unsatisfiable (loops bounded)', () => {
    // start=10 end=8 (impossible) — function should bail after 14*24
    // iterations rather than infinite-loop. We just assert it returns
    // a Date and doesn't hang.
    const d = new Date('2026-05-15T10:00:00Z')
    const out = clampToSendWindow(d, { start_hour: 10, end_hour: 8, skip_days: [] })
    expect(out).toBeInstanceOf(Date)
  })
})

// ── isGoalMet ────────────────────────────────────────────────────

describe('isGoalMet', () => {
  it('returns false for empty/missing goalConfig', async () => {
    expect(await isGoalMet({ db: {}, contact: {}, goalConfig: null })).toBe(false)
    expect(await isGoalMet({ db: {}, contact: {}, goalConfig: {} })).toBe(false)
    expect(await isGoalMet({ db: {}, contact: {}, goalConfig: { type: 'unknown' } })).toBe(false)
  })

  it('pipeline_stage: true when contact.pipeline_stage_slug === value', async () => {
    expect(
      await isGoalMet({
        db: {},
        contact: { pipeline_stage_slug: 'active_member' },
        goalConfig: { type: 'pipeline_stage', value: 'active_member' },
      }),
    ).toBe(true)
    expect(
      await isGoalMet({
        db: {},
        contact: { pipeline_stage_slug: 'active_trial' },
        goalConfig: { type: 'pipeline_stage', value: 'active_member' },
      }),
    ).toBe(false)
  })

  it('lead_status (deprecated alias): still reads pipeline_stage_slug for back-compat', async () => {
    expect(
      await isGoalMet({
        db: {},
        contact: { pipeline_stage_slug: 'active_member' },
        goalConfig: { type: 'lead_status', value: 'active_member' },
      }),
    ).toBe(true)
  })

  it('tag_added: false when tag is empty/whitespace', async () => {
    expect(
      await isGoalMet({
        db: {},
        contact: { id: 'c1' },
        goalConfig: { type: 'tag_added', tag: '  ' },
      }),
    ).toBe(false)
  })

  it('tag_added: true when contact has the active tag', async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockResolvedValue({ count: 2 }),
            }),
          }),
        }),
      }),
    }
    const out = await isGoalMet({
      db,
      contact: { id: 'c1' },
      goalConfig: { type: 'tag_added', tag: 'paid' },
    })
    expect(out).toBe(true)
    expect(db.from).toHaveBeenCalledWith('contact_tags')
  })

  it('tag_added: false when count is 0', async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              is: vi.fn().mockResolvedValue({ count: 0 }),
            }),
          }),
        }),
      }),
    }
    expect(
      await isGoalMet({
        db,
        contact: { id: 'c1' },
        goalConfig: { type: 'tag_added', tag: 'paid' },
      }),
    ).toBe(false)
  })

  it('booking_made: true when contact has any non-cancelled booking', async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            neq: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
      }),
    }
    const out = await isGoalMet({
      db,
      contact: { id: 'c1' },
      goalConfig: { type: 'booking_made' },
    })
    expect(out).toBe(true)
    expect(db.from).toHaveBeenCalledWith('bookings')
  })

  it('booking_made: scoped to event_type_id when provided', async () => {
    const eqMock = vi.fn().mockResolvedValue({ count: 1 })
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            neq: vi.fn().mockReturnValue({
              eq: eqMock,
            }),
          }),
        }),
      }),
    }
    const out = await isGoalMet({
      db,
      contact: { id: 'c1' },
      goalConfig: { type: 'booking_made', event_type_id: 'evt-7' },
    })
    expect(out).toBe(true)
    expect(eqMock).toHaveBeenCalledWith('event_type_id', 'evt-7')
  })

  it('returns false when DB throws (best-effort contract)', async () => {
    const db = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('boom')
      }),
    }
    const out = await isGoalMet({
      db,
      contact: { id: 'c1' },
      goalConfig: { type: 'tag_added', tag: 'paid' },
    })
    expect(out).toBe(false)
  })
})

// ── setEnrollmentStatus ──────────────────────────────────────────

describe('setEnrollmentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates status only when no reason given', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null })
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock })
    const db = { from: vi.fn().mockReturnValue({ update: updateMock }) }
    createServerClient.mockReturnValue(db)

    await setEnrollmentStatus({ enrollmentId: 'e1', status: 'paused' })

    expect(db.from).toHaveBeenCalledWith('sequence_enrollments')
    expect(updateMock).toHaveBeenCalledWith({ status: 'paused' })
    expect(eqMock).toHaveBeenCalledWith('id', 'e1')
  })

  it('also writes last_error when reason is supplied', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null })
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock })
    const db = { from: vi.fn().mockReturnValue({ update: updateMock }) }
    createServerClient.mockReturnValue(db)

    await setEnrollmentStatus({
      enrollmentId: 'e2',
      status: 'exited',
      reason: 'unsubscribed',
    })

    expect(updateMock).toHaveBeenCalledWith({
      status: 'exited',
      last_error: 'unsubscribed',
    })
  })

  it('throws when supabase returns an error', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: new Error('rls denied') })
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock })
    const db = { from: vi.fn().mockReturnValue({ update: updateMock }) }
    createServerClient.mockReturnValue(db)

    await expect(
      setEnrollmentStatus({ enrollmentId: 'e3', status: 'paused' }),
    ).rejects.toThrow('rls denied')
  })
})

// ── public constants ─────────────────────────────────────────────

describe('module constants', () => {
  it('exports MAX_ERRORS = 5 (auto-pause threshold)', () => {
    expect(MAX_ERRORS).toBe(5)
  })

  it('exports PROCESS_BATCH_SIZE = 100 (cron tick cap)', () => {
    expect(PROCESS_BATCH_SIZE).toBe(100)
  })
})

// ── SEQEXIT.1 — the audience as a CONTINUING condition ───────────
//
// The operator case: "Overdue payment → dunning chase" enrols on
// entering the arrears segment. The member pays, Glofox flips them out
// of it — and before this the chase kept sending. The audience filter
// is now re-checked before every step and a contact who no longer
// matches leaves the sequence with exit_reason='left_audience'.
//
// The property that matters more than the feature: the check FAILS
// OPEN. An exit is irreversible with no manual re-entry, so an
// evaluator that answers 'unknown' — bad filter, DB hiccup, anything
// unexpected — must leave the contact enrolled.

import { runSequences } from './scheduler.js'
import { evaluateSequenceAudience } from './audience.js'
import { sendEmailStep } from './steps.js'
import { logWarn } from '@/lib/log'

// Chainable recorder db (graph-advance-scheduler.test.js idiom).
function makeExitDb(route) {
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

const hasOp = (state, method) => state.ops.some(o => o.method === method)
const eqArgOf = (state, col) => state.ops.find(o => o.method === 'eq' && o.args[0] === col)?.args[1]

const exitEnrollment = {
  id: 'en-1', sequence_id: 'seq-1', contact_id: 'c1',
  current_step_order: 1, error_count: 0, status: 'active', metadata: null,
}

const REAL_FILTER = {
  logic: 'and',
  filters: [{ field: 'glofox_membership_state', op: 'eq', value: 'locked' }],
}

// One due enrolment, an active sequence carrying the given
// audience_filter/goal_config, and a single email step at order 2.
function exitRouteFor({ audienceFilter = null, goalConfig = null, contact = { id: 'c1', location_id: 'loc-1' } } = {}) {
  const steps = [
    { id: 'st-2', step_order: 2, step_type: 'email', subject: 'chase', config: { next_step_order: 'end' }, delay_days: 0, delay_hours: 0, delay_minutes: 0 },
  ]
  return (state) => {
    if (state.table === 'sequence_enrollments') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: [exitEnrollment] }
      if (first.method === 'update' && hasOp(state, 'lte')) return { data: [{ id: exitEnrollment.id }] }
      return {}
    }
    if (state.table === 'email_sequences') {
      return {
        data: {
          id: 'seq-1', status: 'active', location_id: 'loc-1',
          goal_config: goalConfig, send_window: null, audience_filter: audienceFilter,
        },
      }
    }
    if (state.table === 'contacts') return { data: contact }
    if (state.table === 'locations') return { data: { settings: {} } }
    if (state.table === 'sequence_steps') {
      const order = eqArgOf(state, 'step_order')
      return { data: steps.find(s => s.step_order === order) ?? null }
    }
    return {}
  }
}

// The enrolment update that carries an exit_reason.
function exitUpdate(statements) {
  return statements.find(s =>
    s.table === 'sequence_enrollments' &&
    s.ops[0]?.method === 'update' &&
    'exit_reason' in (s.ops[0].args[0] || {})
  )
}

describe('runSequences — audience re-check before each step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("exits the enrolment with exit_reason='left_audience' on 'no_match' and sends nothing", async () => {
    const { db, statements } = makeExitDb(exitRouteFor({ audienceFilter: REAL_FILTER }))
    createServerClient.mockReturnValue(db)
    evaluateSequenceAudience.mockResolvedValue('no_match')

    const stats = await runSequences({ now: new Date('2026-08-09T10:00:00Z') })

    expect(sendEmailStep).not.toHaveBeenCalled()
    const exit = exitUpdate(statements)
    expect(exit).toBeTruthy()
    const payload = exit.ops[0].args[0]
    // Mirrors the mig 088 goal_met exit exactly.
    expect(payload.exit_reason).toBe('left_audience')
    expect(payload.status).toBe('exited')
    expect(payload.next_step_at).toBeNull()
    expect(payload.last_processed_at).toBe('2026-08-09T10:00:00.000Z')
    expect(stats.skipped).toBe(1)
    expect(stats.sent).toBe(0)
    expect(stats.errored).toBe(0)
  })

  it("carries on and sends when the contact still matches ('match')", async () => {
    const { db, statements } = makeExitDb(exitRouteFor({ audienceFilter: REAL_FILTER }))
    createServerClient.mockReturnValue(db)
    evaluateSequenceAudience.mockResolvedValue('match')
    sendEmailStep.mockResolvedValue('send-1')

    const stats = await runSequences()

    expect(evaluateSequenceAudience).toHaveBeenCalledTimes(1)
    expect(sendEmailStep).toHaveBeenCalledTimes(1)
    expect(exitUpdate(statements)).toBeFalsy()
    expect(stats.sent).toBe(1)
  })

  it("FAILS OPEN on 'unknown': the contact stays enrolled, the step still sends, and it logs", async () => {
    // THE guarantee. An invalid filter or a transient DB error resolves
    // to 'unknown'; treating that as no_match would irreversibly
    // terminate a live enrolment on a hiccup. Never exit on "we could
    // not tell" — carry on and leave an operator signal.
    const { db, statements } = makeExitDb(exitRouteFor({ audienceFilter: REAL_FILTER }))
    createServerClient.mockReturnValue(db)
    evaluateSequenceAudience.mockResolvedValue('unknown')
    sendEmailStep.mockResolvedValue('send-1')

    const stats = await runSequences()

    expect(exitUpdate(statements)).toBeFalsy()
    expect(sendEmailStep).toHaveBeenCalledTimes(1)
    expect(stats.sent).toBe(1)
    expect(stats.skipped).toBe(0)
    expect(logWarn).toHaveBeenCalledWith(
      'sequences',
      expect.any(String),
      expect.objectContaining({ sequenceId: 'seq-1', contactId: 'c1' }),
    )
  })

  it('never queries the audience when the sequence has no real filter', async () => {
    // The common case (prod 2026-08-09: 5 of 6 sequences null, 1 empty,
    // 0 with a real filter) — don't buy a query per step for nothing.
    for (const audienceFilter of [null, undefined, {}, { logic: 'and' }, { logic: 'and', filters: [] }]) {
      vi.clearAllMocks()
      const { db } = makeExitDb(exitRouteFor({ audienceFilter }))
      createServerClient.mockReturnValue(db)
      sendEmailStep.mockResolvedValue('send-1')

      const stats = await runSequences()

      expect(evaluateSequenceAudience).not.toHaveBeenCalled()
      expect(stats.sent).toBe(1)
    }
  })

  it("goal_met wins when the contact both converted AND left the audience", async () => {
    // Order matters: a converted contact's truer story is 'goal_met',
    // and that's the number the operator's funnel should count.
    const { db, statements } = makeExitDb(exitRouteFor({
      audienceFilter: REAL_FILTER,
      goalConfig: { type: 'pipeline_stage', value: 'active_member' },
      contact: { id: 'c1', location_id: 'loc-1', pipeline_stage_slug: 'active_member' },
    }))
    createServerClient.mockReturnValue(db)
    evaluateSequenceAudience.mockResolvedValue('no_match')

    await runSequences()

    expect(exitUpdate(statements).ops[0].args[0].exit_reason).toBe('goal_met')
    // The goal check short-circuits — the audience is never even asked.
    expect(evaluateSequenceAudience).not.toHaveBeenCalled()
  })
})
