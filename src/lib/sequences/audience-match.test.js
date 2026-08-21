// AUDIENCEMATCH.1 — runAudienceMatchTriggers.
//
// The sweep's whole value is that it CANNOT enrol anyone by accident, so most
// of what is pinned here is refusal: no confirmation, no sweep; outside the
// sending window, no sweep; empty filter, no sweep and a loud log. The happy
// path is one test; the guards are six.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audience-eligibility', () => ({ buildEligibleAudienceQuery: vi.fn() }))
vi.mock('./enrol.js', () => ({ enrolContacts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { buildEligibleAudienceQuery } = await import('@/lib/audience-eligibility')
const { enrolContacts } = await import('./enrol.js')
const { runAudienceMatchTriggers, isInsideSendWindow, AUDIENCE_SWEEP_ENROL_CAP } =
  await import('./cron-triggers.js')

const SEQ_ID = 'seq-am'
const LOC = 'loc-1'
const FILTER = { logic: 'and', filters: [{ field: 'glofox_membership_status', op: 'eq', value: 'trial' }] }

// 14:00 Dublin in August (UTC+1) — inside a 9-19 window.
const INSIDE = new Date('2026-08-20T13:00:00.000Z')

function pageable(rows) {
  // selectAll calls buildQuery(from, to) and expects { data, error }. One short
  // page ends the loop.
  const q = {
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    then: (onFulfilled) => Promise.resolve({ data: rows, error: null }).then(onFulfilled),
  }
  return q
}

function mockDb({ sequences = [], enrolledContactIds = [] } = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'email_sequences') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            then: (f) => Promise.resolve({ data: sequences, error: null }).then(f),
          })),
        }
      }
      if (table === 'sequence_enrollments') {
        return { select: vi.fn(() => pageable(enrolledContactIds.map(id => ({ contact_id: id })))) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

function seq(over = {}) {
  return {
    id: SEQ_ID, location_id: LOC, audience_filter: FILTER,
    audience_seeded_at: '2026-08-20T10:00:00.000Z',
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    ...over,
  }
}

beforeEach(() => {
  createServerClient.mockReset()
  enrolContacts.mockReset()
  buildEligibleAudienceQuery.mockReset()
  logError.mockReset()
  enrolContacts.mockResolvedValue({ enrolled: 0, skipped: 0 })
})

describe('runAudienceMatchTriggers — refusals', () => {
  it('enrols NOBODY when the audience was never confirmed, however long it has been active', async () => {
    // This is the whole safety story: publishing and activating can never
    // mass-enrol. It reproduces the segment first-sync guard's behaviour —
    // the safe outcome is what you get by not thinking about it.
    createServerClient.mockReturnValue(mockDb({ sequences: [seq({ audience_seeded_at: null })] }))
    const stats = await runAudienceMatchTriggers({ now: INSIDE })
    expect(stats.awaiting_seed).toBe(1)
    expect(stats.fired).toBe(0)
    expect(buildEligibleAudienceQuery).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('does not sweep outside the sending window — the first step ignores it', async () => {
    // enrolContacts stamps next_step_at = now(), and the runner only clamps the
    // FOLLOWING step. So a 03:00 sweep would mail everyone at 03:05, outside
    // the sequence's own window and inside the location's quiet hours.
    const at3am = new Date('2026-08-20T02:00:00.000Z') // 03:00 Dublin
    createServerClient.mockReturnValue(mockDb({ sequences: [seq()] }))
    const stats = await runAudienceMatchTriggers({ now: at3am })
    expect(stats.out_of_window).toBe(1)
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('refuses an EMPTY audience filter and logs it, rather than enrolling the whole location', async () => {
    // {logic:'and',filters:[]} is the builder's DEFAULT state, so this is what
    // a half-built sequence looks like — not what "everyone" looks like.
    createServerClient.mockReturnValue(mockDb({
      sequences: [seq({ audience_filter: { logic: 'and', filters: [] } })],
    }))
    const stats = await runAudienceMatchTriggers({ now: INSIDE })
    expect(stats.errored).toBe(1)
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringContaining('audience_filter is empty'), expect.anything())
  })

  it('refuses a null audience filter too', async () => {
    createServerClient.mockReturnValue(mockDb({ sequences: [seq({ audience_filter: null })] }))
    const stats = await runAudienceMatchTriggers({ now: INSIDE })
    expect(stats.errored).toBe(1)
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

describe('runAudienceMatchTriggers — enrolment', () => {
  it('enrols only contacts with no enrolment row — the enrolment table IS the snapshot', async () => {
    createServerClient.mockReturnValue(mockDb({
      sequences: [seq()],
      enrolledContactIds: ['c1', 'c2'],   // already handled, in ANY status
    }))
    buildEligibleAudienceQuery.mockResolvedValue({
      query: pageable([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]),
    })
    enrolContacts.mockResolvedValue({ enrolled: 1, skipped: 0 })

    const stats = await runAudienceMatchTriggers({ now: INSIDE })
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: SEQ_ID,
      contactIds: ['c3'],
      sourceType: 'audience_match',
    }))
    expect(stats.fired).toBe(1)
  })

  it('is a no-op once everyone matching is enrolled — the steady state', async () => {
    createServerClient.mockReturnValue(mockDb({
      sequences: [seq()], enrolledContactIds: ['c1', 'c2'],
    }))
    buildEligibleAudienceQuery.mockResolvedValue({ query: pageable([{ id: 'c1' }, { id: 'c2' }]) })
    const stats = await runAudienceMatchTriggers({ now: INSIDE })
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(stats.fired).toBe(0)
  })

  it('caps writes per tick so a backfill cannot starve other sequences', async () => {
    // The runner is a single global FIFO at PROCESS_BATCH_SIZE=100 across every
    // sequence. Capping at half leaves 50 slots per tick for real-time triggers.
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}` }))
    createServerClient.mockReturnValue(mockDb({ sequences: [seq()] }))
    buildEligibleAudienceQuery.mockResolvedValue({ query: pageable(many) })
    enrolContacts.mockResolvedValue({ enrolled: AUDIENCE_SWEEP_ENROL_CAP, skipped: 0 })

    await runAudienceMatchTriggers({ now: INSIDE })
    const ids = enrolContacts.mock.calls[0][0].contactIds
    expect(ids).toHaveLength(AUDIENCE_SWEEP_ENROL_CAP)
    expect(AUDIENCE_SWEEP_ENROL_CAP).toBeLessThan(100)
  })

  it('does NOT use a manual-like source type, so automations_exempt still applies', async () => {
    createServerClient.mockReturnValue(mockDb({ sequences: [seq()] }))
    buildEligibleAudienceQuery.mockResolvedValue({ query: pageable([{ id: 'c1' }]) })
    enrolContacts.mockResolvedValue({ enrolled: 1, skipped: 0 })
    await runAudienceMatchTriggers({ now: INSIDE })
    const { sourceType } = enrolContacts.mock.calls[0][0]
    expect(['manual', 'churn_radar']).not.toContain(sourceType)
  })

  it('contains a per-sequence failure instead of aborting the sweep (CRONISO.1)', async () => {
    createServerClient.mockReturnValue(mockDb({ sequences: [seq({ id: 'bad' }), seq({ id: 'good' })] }))
    buildEligibleAudienceQuery
      .mockRejectedValueOnce(new Error('filter exploded'))
      .mockResolvedValueOnce({ query: pageable([{ id: 'c9' }]) })
    enrolContacts.mockResolvedValue({ enrolled: 1, skipped: 0 })

    const stats = await runAudienceMatchTriggers({ now: INSIDE })
    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(1)   // the healthy sequence still ran
  })
})

describe('isInsideSendWindow', () => {
  it('is unconstrained when no window is configured', () => {
    expect(isInsideSendWindow(new Date('2026-08-20T02:00:00.000Z'), null)).toBe(true)
    expect(isInsideSendWindow(new Date('2026-08-20T02:00:00.000Z'), {})).toBe(true)
  })

  it('agrees with the runner\'s own clamp', () => {
    const w = { start_hour: 9, end_hour: 19, skip_days: [] }
    expect(isInsideSendWindow(new Date('2026-08-20T13:00:00.000Z'), w)).toBe(true)   // 14:00 Dublin
    expect(isInsideSendWindow(new Date('2026-08-20T02:00:00.000Z'), w)).toBe(false)  // 03:00 Dublin
    expect(isInsideSendWindow(new Date('2026-08-20T21:00:00.000Z'), w)).toBe(false)  // 22:00 Dublin
  })
})
