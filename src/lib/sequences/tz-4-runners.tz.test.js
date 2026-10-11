// tz-4-runners.tz.test.js — TZ.4, the runners. The sequence scheduler, the
// anniversary sweep and the audience_match sweep act on the sequence STUDIO's
// clock (locations.timezone):
//   • a New York studio's next step is clamped on New York's clock;
//   • a New York studio's birthday sweep matches the New York calendar day;
//   • when the zone CANNOT be read (LocationZoneReadError), the runner skips
//     that location / enrolment this pass: nothing is sent or enrolled, no
//     Dublin is guessed, and the run itself never throws.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
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
vi.mock('./audience.js', () => ({
  contactMatchesSequenceAudience: vi.fn(async () => true),
  evaluateSequenceAudience: vi.fn(async () => 'match'),
}))
vi.mock('./enrol.js', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/audience-eligibility', () => ({ buildEligibleAudienceQuery: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { logWarn, logError } = await import('@/lib/log')
const { sendEmailStep } = await import('./steps.js')
const { enrolContacts } = await import('./enrol.js')
const { buildEligibleAudienceQuery } = await import('@/lib/audience-eligibility')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { runSequences } = await import('./scheduler.js')
const { runAnniversaryTriggers, runAudienceMatchTriggers } = await import('./cron-triggers.js')

const NY = 'America/New_York'
const LOC_NY = 'loc-ny'
const LOC_D = 'loc-dub'
const LOC_DOWN = 'loc-unreadable'

beforeEach(() => {
  vi.clearAllMocks()
  resetLocationZoneCache()
  vi.useRealTimers()
})

// ── A route-driven recorder db (the graph-advance-scheduler.test.js idiom) ──
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
const has = (state, method) => state.ops.some((o) => o.method === method)
const eqArg = (state, col) => state.ops.find((o) => o.method === 'eq' && o.args[0] === col)?.args[1]
const inArg = (state, col) => state.ops.find((o) => o.method === 'in' && o.args[0] === col)?.args[1]
const selects = (state, needle) => state.ops.some((o) => o.method === 'select' && String(o.args[0]).includes(needle))

const ZONES = { [LOC_NY]: NY, [LOC_D]: 'Europe/Dublin' }
// A `locations.timezone` read: by id (getLocationZone) or by .in (getLocationZones).
function zoneRead(state) {
  const one = eqArg(state, 'id')
  if (one !== undefined) {
    if (one === LOC_DOWN) return { data: null, error: { message: 'connection reset' } }
    return { data: { id: one, timezone: ZONES[one] ?? null }, error: null }
  }
  const ids = inArg(state, 'id') || []
  if (ids.includes(LOC_DOWN)) return { data: null, error: { message: 'connection reset' } }
  return { data: ids.map((id) => ({ id, timezone: ZONES[id] ?? null })), error: null }
}

// ── runSequences ───────────────────────────────────────────────────────────

const enrollmentAt = (id, sequenceId) => ({
  id, sequence_id: sequenceId, contact_id: `c-${id}`,
  current_step_order: 1, error_count: 0, status: 'active', metadata: null,
})

function schedulerRoute({ enrollments, sequences, followingDelayHours = 1, quiet = null }) {
  return (state) => {
    if (state.table === 'sequence_enrollments') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: enrollments }
      if (first.method === 'update' && has(state, 'lte')) return { data: [{ id: eqArg(state, 'id') }] }
      if (first.method === 'update') return { data: [{ id: eqArg(state, 'id') }], error: null }
      return {}
    }
    if (state.table === 'email_sequences') return { data: sequences[eqArg(state, 'id')] }
    if (state.table === 'contacts') return { data: { id: 'c', location_id: LOC_NY } }
    if (state.table === 'locations') {
      if (selects(state, 'timezone')) return zoneRead(state)
      return { data: { settings: {} } } // the frequency-cap read
    }
    if (state.table === 'company_settings') return { data: quiet ? [quiet] : [] }
    if (state.table === 'sequence_steps') {
      const order = eqArg(state, 'step_order')
      if (order === 2) return { data: { id: 'st-2', step_order: 2, step_type: 'email', config: {} } }
      if (order === 3) return { data: { delay_days: 0, delay_hours: followingDelayHours, delay_minutes: 0 } }
      return { data: null }
    }
    return {}
  }
}
const advanceFor = (statements, enrollmentId) => statements.find((s) =>
  s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && !has(s, 'lte') &&
  'current_step_order' in s.ops[0].args[0] && eqArg(s, 'id') === enrollmentId)

const seq = (id, locationId, over = {}) => ({
  id, status: 'active', location_id: locationId, goal_config: null, audience_filter: null, send_window: null, ...over,
})

describe('TZ.4 runSequences: the clamp runs on the sequence studio clock', () => {
  it('a New York sequence window (9-17) defers an evening step to 09:00 New York, not 09:00 Dublin', async () => {
    // now 20:00 EDT Wed 1 Jul (01:00 IST Thu); following step +1h = 21:00 EDT
    const now = new Date('2026-07-02T00:00:00Z')
    const { db, statements } = makeDb(schedulerRoute({
      enrollments: [enrollmentAt('en-ny', 'seq-ny')],
      sequences: { 'seq-ny': seq('seq-ny', LOC_NY, { send_window: { start_hour: 9, end_hour: 17, skip_days: [] } }) },
    }))
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockResolvedValue(null)

    const stats = await runSequences({ now })

    expect(stats.sent).toBe(1)
    expect(stats.zone_unavailable).toBe(0)
    // 09:00 EDT Thu 2 Jul = 13:00Z (Dublin's 09:00 IST would be 08:00Z)
    expect(advanceFor(statements, 'en-ny').ops[0].args[0].next_step_at).toBe('2026-07-02T13:00:00.000Z')
  })

  it('a New York sequence with no window falls back to quiet hours on New York\'s clock, across the fall-back', async () => {
    // now 20:30 EDT Sat 31 Oct; +1h = 21:30 EDT → quiet until 08:00 EST Sun 1 Nov = 13:00Z
    const now = new Date('2026-11-01T00:30:00Z')
    const { db, statements } = makeDb(schedulerRoute({
      enrollments: [enrollmentAt('en-ny', 'seq-ny')],
      sequences: { 'seq-ny': seq('seq-ny', LOC_NY) },
      quiet: { send_quiet_hours_enabled: true, send_quiet_hours_start: 21, send_quiet_hours_end: 8 },
    }))
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockResolvedValue(null)

    await runSequences({ now })

    expect(advanceFor(statements, 'en-ny').ops[0].args[0].next_step_at).toBe('2026-11-01T13:00:00.000Z')
  })

  it('an unreadable zone skips THAT enrolment before anything is sent; another studio\'s enrolment still runs', async () => {
    const now = new Date('2026-07-01T14:00:00Z')
    const { db, statements } = makeDb(schedulerRoute({
      enrollments: [enrollmentAt('en-down', 'seq-down'), enrollmentAt('en-dub', 'seq-dub')],
      sequences: {
        'seq-down': seq('seq-down', LOC_DOWN, { send_window: { start_hour: 9, end_hour: 17, skip_days: [] } }),
        'seq-dub': seq('seq-dub', LOC_D, { send_window: { start_hour: 9, end_hour: 17, skip_days: [] } }),
      },
    }))
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockResolvedValue(null)

    const stats = await runSequences({ now }) // never throws

    expect(stats.zone_unavailable).toBe(1)
    expect(stats.errored).toBe(0)
    expect(stats.sent).toBe(1)
    // Only the readable studio's step was dispatched.
    expect(sendEmailStep).toHaveBeenCalledTimes(1)
    expect(sendEmailStep.mock.calls[0][1].enrollment.id).toBe('en-dub')
    // The skipped enrolment was left on its claim lease: no advance, no error
    // write (error_count / last_error untouched), so it simply runs again later.
    expect(advanceFor(statements, 'en-down')).toBeUndefined()
    const downWrites = statements.filter((s) => s.table === 'sequence_enrollments' && s.ops[0]?.method === 'update' && eqArg(s, 'id') === 'en-down')
    expect(downWrites).toHaveLength(1) // the claim CAS only
    expect(has(downWrites[0], 'lte')).toBe(true)
    expect(logWarn).toHaveBeenCalledWith('sequences', expect.stringContaining('timezone unreadable'), expect.objectContaining({ locationId: LOC_DOWN }))
  })

  it('a test enrolment (never clamped) needs no zone, so an unreadable zone does not hold it back', async () => {
    const now = new Date('2026-07-01T14:00:00Z')
    const testEnrolment = { ...enrollmentAt('en-test', 'seq-down'), metadata: { test: true } }
    const { db, statements } = makeDb(schedulerRoute({
      enrollments: [testEnrolment],
      sequences: { 'seq-down': seq('seq-down', LOC_DOWN) },
    }))
    createServerClient.mockReturnValue(db)
    sendEmailStep.mockResolvedValue(null)

    const stats = await runSequences({ now })

    expect(stats.sent).toBe(1)
    expect(stats.zone_unavailable).toBe(0)
    expect(statements.some((s) => s.table === 'locations' && selects(s, 'timezone'))).toBe(false)
  })
})

// ── runAnniversaryTriggers ─────────────────────────────────────────────────

function sweepRoute({ sequences, contactsByLocation = {} }) {
  return (state) => {
    if (state.table === 'email_sequences') return { data: sequences, error: null }
    if (state.table === 'locations') return zoneRead(state)
    if (state.table === 'contacts') return { data: contactsByLocation[eqArg(state, 'location_id')] || [], error: null }
    if (state.table === 'sequence_enrollments') return { data: [], error: null }
    return { data: [], error: null }
  }
}

describe('TZ.4 runAnniversaryTriggers: the birthday day is the studio\'s calendar day', () => {
  const birthdaySeq = (id, locationId) => ({ id, location_id: locationId, trigger_config: { from_field: 'dob', days_after: 0 }, audience_filter: null })

  it('at 22:00 EDT on 30 Jun a New York studio greets 30 Jun birthdays; a Dublin studio (already 1 Jul) greets 1 Jul', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-01T02:00:00Z'))
    const contacts = [{ id: 'c-jun30', dob: '1990-06-30' }, { id: 'c-jul1', dob: '1985-07-01' }]
    const { db } = makeDb(sweepRoute({
      sequences: [birthdaySeq('seq-ny', LOC_NY), birthdaySeq('seq-dub', LOC_D)],
      contactsByLocation: { [LOC_NY]: contacts, [LOC_D]: contacts },
    }))
    createServerClient.mockReturnValue(db)
    enrolContacts.mockResolvedValue({ enrolled: 1 })

    const stats = await runAnniversaryTriggers()

    expect(stats).toEqual({ fired: 2, skipped: 0, errored: 0 })
    const calls = enrolContacts.mock.calls.map(([a]) => [a.sequenceId, a.contactIds[0], a.sourceRef])
    expect(calls).toEqual([
      ['seq-ny', 'c-jun30', 'dob:0:2026'],
      ['seq-dub', 'c-jul1', 'dob:0:2026'],
    ])
  })

  it('the dedup year is the studio\'s year at New Year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-01-01T03:00:00Z')) // 22:00 EST 31 Dec 2026; 03:00 GMT 1 Jan 2027 in Dublin
    const { db } = makeDb(sweepRoute({
      sequences: [birthdaySeq('seq-ny', LOC_NY), birthdaySeq('seq-dub', LOC_D)],
      contactsByLocation: {
        [LOC_NY]: [{ id: 'c-dec31', dob: '1990-12-31' }],
        [LOC_D]: [{ id: 'c-jan1', dob: '1990-01-01' }],
      },
    }))
    createServerClient.mockReturnValue(db)
    enrolContacts.mockResolvedValue({ enrolled: 1 })

    await runAnniversaryTriggers()

    expect(enrolContacts.mock.calls.map(([a]) => a.sourceRef)).toEqual(['dob:0:2026', 'dob:0:2027'])
  })

  it('an unreadable zone skips the sweep this pass: nothing enrolled, no contact read, no throw, counted and logged', async () => {
    const { db, statements } = makeDb(sweepRoute({
      sequences: [birthdaySeq('seq-down', LOC_DOWN), birthdaySeq('seq-ny', LOC_NY)],
      contactsByLocation: { [LOC_NY]: [{ id: 'c', dob: '1990-06-30' }] },
    }))
    createServerClient.mockReturnValue(db)

    const stats = await runAnniversaryTriggers()

    expect(stats).toEqual({ fired: 0, skipped: 0, errored: 2 })
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(statements.some((s) => s.table === 'contacts')).toBe(false)
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringContaining('timezones unreadable'), expect.objectContaining({ locationIds: expect.arrayContaining([LOC_DOWN]) }))
  })
})

// ── runAudienceMatchTriggers ───────────────────────────────────────────────

describe('TZ.4 runAudienceMatchTriggers: the first-step window is the studio\'s clock', () => {
  const FILTER = { logic: 'and', filters: [{ field: 'glofox_membership_status', op: 'eq', value: 'trial' }] }
  const amSeq = (id, locationId) => ({
    id, location_id: locationId, audience_filter: FILTER, audience_seeded_at: '2026-08-01T00:00:00Z',
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
  })
  const pageable = (rows) => {
    const q = { order: () => q, range: () => q, then: (f) => Promise.resolve({ data: rows, error: null }).then(f) }
    return q
  }

  it('at 08:00 EDT (13:00 IST) the New York sequence is out of window and the Dublin one sweeps', async () => {
    const { db } = makeDb(sweepRoute({ sequences: [amSeq('seq-ny', LOC_NY), amSeq('seq-dub', LOC_D)] }))
    createServerClient.mockReturnValue(db)
    buildEligibleAudienceQuery.mockImplementation(async () => ({ query: pageable([{ id: 'c1' }]) }))
    enrolContacts.mockResolvedValue({ enrolled: 1 })

    const stats = await runAudienceMatchTriggers({ now: new Date('2026-08-20T12:00:00Z') })

    expect(stats.out_of_window).toBe(1)
    expect(stats.fired).toBe(1)
    expect(enrolContacts).toHaveBeenCalledTimes(1)
    expect(enrolContacts.mock.calls[0][0].sequenceId).toBe('seq-dub')
  })

  it('an unreadable zone opens no window: nothing enrolled, no throw, counted as errored', async () => {
    const { db } = makeDb(sweepRoute({ sequences: [amSeq('seq-down', LOC_DOWN)] }))
    createServerClient.mockReturnValue(db)

    const stats = await runAudienceMatchTriggers({ now: new Date('2026-08-20T13:00:00Z') })

    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(0)
    expect(buildEligibleAudienceQuery).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})
