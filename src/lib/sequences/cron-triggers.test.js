// Cron-driven trigger runner tests. Three runners share a shape
// (sweep candidates → audience → dedup → enrol → return stats), so
// the tests focus on the bits that ARE distinct per runner:
//
//   • event_reminder    — hours_before validation, the time-window
//                         + tolerance math, the per-(seq, contact,
//                         booking) dedup
//   • anniversary       — from_field allowlist (only specific
//                         columns are queryable), days_after
//                         validation, sourceRef format
//   • inactivity        — signal-field allowlist, the derived
//                         last_booking_at branch (set difference),
//                         unknown-signal fall-through
//
// We don't re-test enrolContacts (separate test file) or audience
// matching (audience.test.js). We assert this layer's
// trigger_config validation + the right enrolContacts.sourceRef
// shape per trigger.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('./audience.js', () => ({ contactMatchesSequenceAudience: vi.fn() }))
vi.mock('./enrol.js', () => ({ enrolContacts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { logError } = await import('@/lib/log')
const { contactMatchesSequenceAudience } = await import('./audience.js')
const { enrolContacts } = await import('./enrol.js')
const cronTriggers = await import('./cron-triggers.js')

beforeEach(() => {
  createServerClient.mockReset()
  contactMatchesSequenceAudience.mockReset()
  enrolContacts.mockReset()
  contactMatchesSequenceAudience.mockResolvedValue(true)
  enrolContacts.mockResolvedValue({ enrolled: 1, skipped: 0 })
})

/**
 * Mock Supabase client whose .from(table) returns a builder. Each
 * table maps to a config — use `list` for thenable/await chains,
 * `maybeSingle` for the dedup-style lookups, `single` for one-row.
 *
 * Tables that are queried multiple times (e.g. contacts twice in
 * inactivity.last_booking_at) accept arrays — successive calls
 * shift() one config off.
 *
 * `error: 'msg'` makes the awaited chain resolve { data: null, error }
 * — the shape PostgREST returns for a bad column / transient failure,
 * and the shape selectAll turns into a throw.
 */
function mockDb(tables) {
  const calls = []
  return {
    calls,
    from: vi.fn((table) => {
      const t = tables[table]
      if (!t) throw new Error(`unexpected table: ${table}`)
      const cfg = Array.isArray(t) ? t.shift() : t
      const record = (method) => vi.fn((...args) => { calls.push({ table, method, args }); return builder })
      const builder = {
        select: record('select'),
        eq: record('eq'),
        in: record('in'),
        gte: record('gte'),
        lte: record('lte'),
        lt: record('lt'),
        not: record('not'),
        limit: record('limit'),
        order: record('order'),
        range: record('range'),
        maybeSingle: vi.fn().mockResolvedValue({ data: cfg.maybeSingle ?? null, error: null }),
        single: vi.fn().mockResolvedValue({ data: cfg.single ?? null, error: null }),
        then: (onF) => Promise.resolve(
          cfg.error
            ? { data: null, error: { message: cfg.error } }
            : { data: cfg.list ?? [], error: null },
        ).then(onF),
      }
      return builder
    }),
  }
}

// ── event_reminder ──────────────────────────────────────────────

describe('runEventReminderTriggers', () => {
  it('returns zero stats when there are no active event_reminder sequences', async () => {
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runEventReminderTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a sequence whose hours_before is missing / non-numeric / negative', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: {}, audience_filter: null },
        { id: 's2', location_id: 'loc-1', trigger_config: { hours_before: 'soon' }, audience_filter: null },
        { id: 's3', location_id: 'loc-1', trigger_config: { hours_before: -1 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runEventReminderTriggers()).toEqual({ fired: 0, skipped: 0, errored: 3 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips bookings whose composed timestamp falls outside the ±1h window', async () => {
    // Sequence wants 24h before. Booking is 6h before NOW → outside
    // the ±1h tolerance around the 24h target.
    const farFuture = new Date(Date.now() + 6 * 3600_000)
    const dateStr = farFuture.toISOString().slice(0, 10)
    const timeStr = farFuture.toISOString().slice(11, 19)

    // The DB-level date filter is a wide gte/lte — it'll return the
    // booking, but the in-memory exact-window check should reject.
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { hours_before: 24 }, audience_filter: null },
      ] },
      bookings: { list: [
        { id: 'b1', contact_id: 'c1', booking_date: dateStr, start_time: timeStr, event_type_id: 'evt-A' },
      ] },
    }))
    await cronTriggers.runEventReminderTriggers()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a booking with no contact_id', async () => {
    const target = new Date(Date.now() + 24 * 3600_000)
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { hours_before: 24 }, audience_filter: null },
      ] },
      bookings: { list: [
        { id: 'b1', contact_id: null, booking_date: target.toISOString().slice(0, 10), start_time: target.toISOString().slice(11, 19) },
      ] },
    }))
    await cronTriggers.runEventReminderTriggers()
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips when (sequence, contact, booking) is already enrolled (any status)', async () => {
    const target = new Date(Date.now() + 24 * 3600_000)
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { hours_before: 24 }, audience_filter: null },
      ] },
      bookings: { list: [
        { id: 'b1', contact_id: 'c1', booking_date: target.toISOString().slice(0, 10), start_time: target.toISOString().slice(11, 19), event_type_id: 'evt-A' },
      ] },
      sequence_enrollments: { maybeSingle: { id: 'enr-1' } }, // already enrolled
    }))
    const stats = await cronTriggers.runEventReminderTriggers()
    expect(stats.skipped).toBe(1)
    expect(stats.fired).toBe(0)
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('enrols with sourceType=event_reminder and sourceRef=booking.id when in window', async () => {
    const target = new Date(Date.now() + 24 * 3600_000)
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { hours_before: 24 }, audience_filter: null },
      ] },
      bookings: { list: [
        { id: 'b1', contact_id: 'c1', booking_date: target.toISOString().slice(0, 10), start_time: target.toISOString().slice(11, 19), event_type_id: 'evt-A' },
      ] },
      sequence_enrollments: { maybeSingle: null },
    }))
    const stats = await cronTriggers.runEventReminderTriggers()
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sequenceId: 's1',
      contactIds: ['c1'],
      sourceType: 'event_reminder',
      sourceRef: 'b1',
    }))
    expect(stats.fired).toBe(1)
  })

  it('respects event_type_id scope on the trigger_config', async () => {
    const target = new Date(Date.now() + 24 * 3600_000)
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { hours_before: 24, event_type_id: 'evt-B' }, audience_filter: null },
      ] },
      bookings: { list: [
        { id: 'b1', contact_id: 'c1', booking_date: target.toISOString().slice(0, 10), start_time: target.toISOString().slice(11, 19), event_type_id: 'evt-A' },
      ] },
    }))
    await cronTriggers.runEventReminderTriggers()
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

// ── anniversary ─────────────────────────────────────────────────

describe('runAnniversaryTriggers', () => {
  it('returns zero stats when no active sequences', async () => {
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runAnniversaryTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
  })

  it('skips a sequence with non-numeric / negative days_after', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: {}, audience_filter: null },
        { id: 's2', location_id: 'loc-1', trigger_config: { days_after: 'soon' }, audience_filter: null },
        { id: 's3', location_id: 'loc-1', trigger_config: { days_after: -5 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runAnniversaryTriggers()).toEqual({ fired: 0, skipped: 0, errored: 3 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  // COMMSFIX.E.3 — an unknown from_field used to silently FALL BACK to
  // lead_created_at, which is how the birthday template ({ from_field:
  // 'dob' }) sent 'Happy birthday' to every lead created that day and
  // never to anyone on their birthday. Unknown fields now REJECT the
  // sequence's config with a logged error — no query, no enrolments.
  it('COMMSFIX.E.3 — unknown from_field rejects the config with a logged error (no silent fallback)', async () => {
    const db = mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'created_at_im_evil', days_after: 30 }, audience_filter: null },
      ] },
    })
    createServerClient.mockReturnValue(db)
    const stats = await cronTriggers.runAnniversaryTriggers()
    expect(stats).toEqual({ fired: 0, skipped: 0, errored: 1 })
    expect(enrolContacts).not.toHaveBeenCalled()
    // No contacts query at all — the config is rejected before the sweep.
    expect(db.calls.some((c) => c.table === 'contacts')).toBe(false)
    expect(logError).toHaveBeenCalledWith(
      'sequences',
      expect.stringMatching(/created_at_im_evil/),
      expect.anything(),
    )
  })

  // COMMSFIX.E.3 — the dedup source_ref now carries the occurrence YEAR so
  // the same anniversary re-fires next year (still subject to
  // re_enrolment_cooldown_days, enforced inside enrolContacts).
  it('uses sourceRef = `${from_field}:${days_after}:${year}` for dedup (yearly re-fire)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-09T10:00:00Z') })
    try {
      createServerClient.mockReturnValue(mockDb({
        email_sequences: { list: [
          { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'last_emailed_at', days_after: 365 }, audience_filter: null },
        ] },
        contacts: { list: [{ id: 'c1' }] },
        sequence_enrollments: { list: [] }, // no existing enrolment
      }))
      await cronTriggers.runAnniversaryTriggers()
      expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'anniversary',
        sourceRef: 'last_emailed_at:365:2026',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('COMMSFIX.E.3 — joined_at is an allowed from_field', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-09T10:00:00Z') })
    try {
      createServerClient.mockReturnValue(mockDb({
        email_sequences: { list: [
          { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'joined_at', days_after: 365 }, audience_filter: null },
        ] },
        contacts: { list: [{ id: 'c1' }] },
        sequence_enrollments: { list: [] },
      }))
      const stats = await cronTriggers.runAnniversaryTriggers()
      expect(stats.fired).toBe(1)
      expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'anniversary',
        sourceRef: 'joined_at:365:2026',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('COMMSFIX.E.3 — dob matches on month+day in Dublin wall-clock, any birth year', async () => {
    // 23:30 UTC on 9 Aug is ALREADY 10 Aug in Dublin (BST, UTC+1) — a
    // process-local-date implementation run under a US TZ would compute
    // 08-09 and match the wrong contact. The Dublin calendar day is the
    // business day for birthdays (repo TZ rule).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-09T23:30:00Z') })
    try {
      createServerClient.mockReturnValue(mockDb({
        email_sequences: { list: [
          { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'dob', days_after: 0 }, audience_filter: null },
        ] },
        contacts: { list: [
          { id: 'c-birthday-1990', dob: '1990-08-10' },  // birthday today (Dublin) — matches despite the birth year
          { id: 'c-birthday-2001', dob: '2001-08-10' },  // also matches — year-modulo
          { id: 'c-yesterday', dob: '1990-08-09' },      // Dublin yesterday — no match
          { id: 'c-no-dob', dob: null },                 // no dob — no match
        ] },
        sequence_enrollments: { list: [] },
      }))
      const stats = await cronTriggers.runAnniversaryTriggers()
      expect(stats.fired).toBe(2)
      expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
        contactIds: ['c-birthday-1990'],
        sourceType: 'anniversary',
        sourceRef: 'dob:0:2026',
      }))
      expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
        contactIds: ['c-birthday-2001'],
        sourceRef: 'dob:0:2026',
      }))
      const enrolledIds = enrolContacts.mock.calls.flatMap(([args]) => args.contactIds)
      expect(enrolledIds).not.toContain('c-yesterday')
      expect(enrolledIds).not.toContain('c-no-dob')
    } finally {
      vi.useRealTimers()
    }
  })

  it('COMMSFIX.E.3 — dob dedup carries the occurrence year, so the same birthday re-fires next year', async () => {
    // Same contact, same config, one year later → a DIFFERENT sourceRef,
    // so the all-statuses dedup lookup no longer blocks the enrolment
    // (the cooldown knob, enforced in enrolContacts, is the remaining gate).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-08-09T23:30:00Z') })
    try {
      createServerClient.mockReturnValue(mockDb({
        email_sequences: { list: [
          { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'dob', days_after: 0 }, audience_filter: null },
        ] },
        contacts: { list: [{ id: 'c-birthday-1990', dob: '1990-08-10' }] },
        sequence_enrollments: { list: [] },
      }))
      await cronTriggers.runAnniversaryTriggers()
      expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
        sourceRef: 'dob:0:2027',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips contact when (sequence, contact, sourceRef) already exists', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { days_after: 30 }, audience_filter: null },
      ] },
      contacts: { list: [{ id: 'c1' }] },
      sequence_enrollments: { list: [{ id: 'enr-existing' }] },
    }))
    const stats = await cronTriggers.runAnniversaryTriggers()
    expect(stats).toEqual({ fired: 0, skipped: 1, errored: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

// ── inactivity ──────────────────────────────────────────────────

describe('runInactivityTriggers', () => {
  it('returns zero stats when no active sequences', async () => {
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
  })

  it('skips a sequence with non-numeric / non-positive days_inactive', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: {}, audience_filter: null },
        { id: 's2', location_id: 'loc-1', trigger_config: { days_inactive: 0 }, audience_filter: null },
        { id: 's3', location_id: 'loc-1', trigger_config: { days_inactive: -7 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0, errored: 3 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a sequence with an unknown signal value', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_login_at', days_inactive: 30 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0, errored: 1 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('uses sourceRef = `${signal}:${days_inactive}`', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_emailed_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: { list: [{ id: 'c1' }] },
      sequence_enrollments: { list: [] },
    }))
    await cronTriggers.runInactivityTriggers()
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'inactivity',
      sourceRef: 'last_emailed_at:60',
    }))
  })

  it('defaults signal to last_emailed_at when missing', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: { list: [{ id: 'c1' }] },
      sequence_enrollments: { list: [] },
    }))
    await cronTriggers.runInactivityTriggers()
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'last_emailed_at:60',
    }))
  })

  it('derived last_booking_at: set difference picks contacts with NO recent booking', async () => {
    // Two contacts at the location; only c2 has a recent booking →
    // c1 is inactive.
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_booking_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: [
        { list: [{ id: 'c1' }, { id: 'c2' }] }, // first call: pull all contacts
      ],
      bookings: { list: [{ contact_id: 'c2' }] },  // c2 has recent booking
      sequence_enrollments: { list: [] },
    }))
    await cronTriggers.runInactivityTriggers()
    // Only c1 should be enrolled (c2 is "active" via recent booking).
    expect(enrolContacts).toHaveBeenCalledTimes(1)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({
      contactIds: ['c1'],
      sourceType: 'inactivity',
    }))
  })

  // ── COMMSFIX.E.2 — the sweeps must paginate the FULL matching set ──
  //
  // The audit confirmed the CAMPAIGN.14 truncation class unfixed here:
  // unordered .limit(500) queries returned the DB's arbitrary first 500
  // rows every tick; already-enrolled rows still match the filter, so the
  // same 500 came back forever and contacts beyond row 500 were NEVER
  // swept. The queries must page the whole set with .order('id') +
  // .range() (the selectAll recipe).

  it('COMMSFIX.E.2 — inactivity stored-signal sweep paginates past 1000 rows with .order(id) + .range()', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}` }))
    const page2 = [{ id: 'c1000' }, { id: 'c1001' }, { id: 'c1002' }]
    const db = mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_email_open_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: [{ list: page1 }, { list: page2 }],
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)
    const stats = await cronTriggers.runInactivityTriggers()
    expect(stats.fired).toBe(1003)
    expect(enrolContacts).toHaveBeenCalledTimes(1003)
    // Stable ordering is what makes .range() paging sound.
    expect(db.calls).toContainEqual({ table: 'contacts', method: 'order', args: ['id'] })
    expect(db.calls.filter((c) => c.table === 'contacts' && c.method === 'range').length).toBeGreaterThanOrEqual(2)
  })

  it('COMMSFIX.E.2 — anniversary sweep paginates past 1000 rows with .order(id) + .range()', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}` }))
    const page2 = [{ id: 'c1000' }, { id: 'c1001' }]
    const db = mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'last_emailed_at', days_after: 365 }, audience_filter: null },
      ] },
      contacts: [{ list: page1 }, { list: page2 }],
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)
    const stats = await cronTriggers.runAnniversaryTriggers()
    expect(stats.fired).toBe(1002)
    expect(enrolContacts).toHaveBeenCalledTimes(1002)
    expect(db.calls).toContainEqual({ table: 'contacts', method: 'order', args: ['id'] })
    expect(db.calls.filter((c) => c.table === 'contacts' && c.method === 'range').length).toBeGreaterThanOrEqual(2)
  })

  it('COMMSFIX.E.2 — derived last_booking_at scans ALL location contacts, not the first 500', async () => {
    // 1002 contacts at the location; only c0 has a recent booking →
    // 1001 inactive contacts must be considered (the old code capped
    // the whole scan at an unordered 500).
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}` }))
    const page2 = [{ id: 'c1000' }, { id: 'c1001' }]
    const db = mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_booking_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: [{ list: page1 }, { list: page2 }],
      bookings: { list: [{ contact_id: 'c0' }] },
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)
    const stats = await cronTriggers.runInactivityTriggers()
    expect(stats.fired).toBe(1001)
    expect(enrolContacts).toHaveBeenCalledTimes(1001)
    expect(enrolContacts).not.toHaveBeenCalledWith(expect.objectContaining({ contactIds: ['c0'] }))
    expect(db.calls).toContainEqual({ table: 'contacts', method: 'order', args: ['id'] })
  })

  it('derived last_booking_at: short-circuits when there are no contacts at the location', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_booking_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: { list: [] },
    }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

// ── GAPS-P1.4 — a stored inactivity signal must be a REAL contacts column ──
//
// This is the guard that would have caught Defect A. 'last_email_open_at' sat
// in this whitelist, in the SequenceSettings dropdown and in BOTH packaged
// win-back templates while no such column existed on public.contacts, and the
// docstring above runInactivityTriggers asserted the opposite. Nothing could
// see it: mocked tests and `next build` do not know the live schema, and the
// only symptom in prod would have been a console.warn as a 42703 took out the
// inactivity sweep for every sequence at every location (selectAll throws,
// runInactivityTriggers has no inner try/catch, the sole catch is at the cron
// boundary).
//
// AUDIENCE_FIELDS is the repo's registry of real, queryable contacts columns —
// every entry is a column applyAudienceFilter puts in a live WHERE clause, so
// a name that got in here without getting in there is the same defect again.
describe('runInactivityTriggers — stored signals are real contacts columns (GAPS-P1.4)', () => {
  it('exports the stored-signal whitelist so the contract is checkable', () => {
    expect(cronTriggers.INACTIVITY_SIGNAL_FIELDS).toBeTypeOf('object')
    expect(Object.keys(cronTriggers.INACTIVITY_SIGNAL_FIELDS).length).toBeGreaterThan(0)
  })

  it('every stored signal is a registered date field in AUDIENCE_FIELDS', async () => {
    const { AUDIENCE_FIELDS } = await import('@/lib/audience-filter')
    for (const [signal, column] of Object.entries(cronTriggers.INACTIVITY_SIGNAL_FIELDS)) {
      expect(AUDIENCE_FIELDS[column], `${signal} → contacts.${column} is not a registered field`).toBeDefined()
      expect(AUDIENCE_FIELDS[column].type, `${signal} → contacts.${column} is not a date field`).toBe('date')
    }
  })

  it('offers last_email_open_at as a stored signal (mig 511 made the column real)', () => {
    expect(cronTriggers.INACTIVITY_SIGNAL_FIELDS.last_email_open_at).toBe('last_email_open_at')
  })
})

// GAPS-P3.2 — the anniversary from_field whitelist is now an EXPORTED
// contract rather than a literal buried in the runner, so the shipped
// templates and the SequenceSettings dropdown can be held against the
// same list by test. Same reasoning as GAPS-P1.4 above: a field name
// that gets into one list and not the others produces a sequence that
// logs an error and skips on every tick, forever, with no UI symptom.
describe('runAnniversaryTriggers — the from_field whitelist is exported (GAPS-P3.2)', () => {
  it('exports ANNIVERSARY_FROM_FIELDS as a frozen list of field names', () => {
    expect(Array.isArray(cronTriggers.ANNIVERSARY_FROM_FIELDS)).toBe(true)
    expect(cronTriggers.ANNIVERSARY_FROM_FIELDS.length).toBeGreaterThan(0)
    expect(Object.isFrozen(cronTriggers.ANNIVERSARY_FROM_FIELDS)).toBe(true)
  })

  it('re-exports the shared constant (one source, not a copy)', async () => {
    const shared = await import('./anniversary-fields.js')
    expect(cronTriggers.ANNIVERSARY_FROM_FIELDS).toBe(shared.ANNIVERSARY_FROM_FIELDS)
  })

  it('the guard accepts every field in the exported list', async () => {
    for (const field of cronTriggers.ANNIVERSARY_FROM_FIELDS) {
      logError.mockClear()
      enrolContacts.mockClear()
      createServerClient.mockReturnValue(mockDb({
        email_sequences: { list: [
          { id: 's1', location_id: 'loc-1', trigger_config: { from_field: field, days_after: 1 }, audience_filter: null },
        ] },
        contacts: { list: [] },
      }))
      await cronTriggers.runAnniversaryTriggers()
      expect(logError, `${field} was rejected by the guard`).not.toHaveBeenCalled()
    }
  })

  it('every non-dob field is a registered date field in AUDIENCE_FIELDS', async () => {
    // dob is a DATE column matched by month+day string slice, not a
    // timestamp window, and is deliberately not an audience field.
    const { AUDIENCE_FIELDS } = await import('@/lib/audience-filter')
    for (const field of cronTriggers.ANNIVERSARY_FROM_FIELDS.filter((f) => f !== 'dob')) {
      expect(AUDIENCE_FIELDS[field], `contacts.${field} is not a registered field`).toBeDefined()
      expect(AUDIENCE_FIELDS[field].type, `contacts.${field} is not a date field`).toBe('date')
    }
  })
})

// ── CRONISO.1 — per-sequence isolation (blast radius) ───────────
//
// All three cron runners walked their sequences in a bare for-loop with
// no inner try/catch. selectAll throws on a query error, enrolContacts
// can throw, and the audience check hits the DB — so ANY failure on ONE
// sequence (a bad signal column, a transient PostgREST error, one
// location's data) propagated straight out of the runner and aborted the
// sweep. Every REMAINING sequence at every OTHER location was silently
// skipped for that tick, and the only symptom was a console.warn at the
// cron boundary.
//
// The contract these tests pin: one bad sequence costs exactly one
// sequence, it is counted in stats.errored, and it is logged with its
// own id so the operator can find it without a log dive.
describe('cron triggers — one failing sequence must not stop the others (CRONISO.1)', () => {
  it('runInactivityTriggers — a sweep query error is contained to its own sequence', async () => {
    const db = mockDb({
      email_sequences: { list: [
        { id: 'seq-bad', location_id: 'loc-1', trigger_config: { signal: 'last_emailed_at', days_inactive: 60 }, audience_filter: null },
        { id: 'seq-good', location_id: 'loc-2', trigger_config: { signal: 'last_emailed_at', days_inactive: 60 }, audience_filter: null },
      ] },
      // First sequence's sweep 42703s (the GAPS-P1 class); second is fine.
      contacts: [
        { error: 'column contacts.last_emailed_at does not exist' },
        { list: [{ id: 'c1' }] },
      ],
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)

    const stats = await cronTriggers.runInactivityTriggers()

    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(1)
    expect(enrolContacts).toHaveBeenCalledTimes(1)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: 'seq-good' }))
    expect(logError).toHaveBeenCalledWith(
      'sequences',
      expect.stringContaining('seq-bad'),
      expect.objectContaining({ sequenceId: 'seq-bad' }),
    )
  })

  it('runInactivityTriggers — the derived last_booking_at branch is contained too', async () => {
    const db = mockDb({
      email_sequences: { list: [
        { id: 'seq-bad', location_id: 'loc-1', trigger_config: { signal: 'last_booking_at', days_inactive: 60 }, audience_filter: null },
        { id: 'seq-good', location_id: 'loc-2', trigger_config: { signal: 'last_emailed_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: [
        { list: [{ id: 'c1' }] },        // seq-bad: contacts fine…
        { list: [{ id: 'c9' }] },        // seq-good sweep
      ],
      bookings: { error: 'timeout' },    // …bookings lookup blows up
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)

    const stats = await cronTriggers.runInactivityTriggers()

    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(1)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: 'seq-good' }))
  })

  it('runAnniversaryTriggers — an enrol failure is contained to its own sequence', async () => {
    enrolContacts.mockRejectedValueOnce(new Error('enrol exploded'))
    const db = mockDb({
      email_sequences: { list: [
        { id: 'seq-bad', location_id: 'loc-1', trigger_config: { from_field: 'joined_at', days_after: 365 }, audience_filter: null },
        { id: 'seq-good', location_id: 'loc-2', trigger_config: { from_field: 'joined_at', days_after: 365 }, audience_filter: null },
      ] },
      contacts: [{ list: [{ id: 'c1' }] }, { list: [{ id: 'c2' }] }],
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)

    const stats = await cronTriggers.runAnniversaryTriggers()

    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(1)
    expect(enrolContacts).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledWith(
      'sequences',
      expect.stringContaining('seq-bad'),
      expect.objectContaining({ sequenceId: 'seq-bad' }),
    )
  })

  it('runAnniversaryTriggers — a sweep query error is contained to its own sequence', async () => {
    const db = mockDb({
      email_sequences: { list: [
        { id: 'seq-bad', location_id: 'loc-1', trigger_config: { from_field: 'joined_at', days_after: 365 }, audience_filter: null },
        { id: 'seq-good', location_id: 'loc-2', trigger_config: { from_field: 'joined_at', days_after: 365 }, audience_filter: null },
      ] },
      contacts: [{ error: 'statement timeout' }, { list: [{ id: 'c2' }] }],
      sequence_enrollments: { list: [] },
    })
    createServerClient.mockReturnValue(db)

    const stats = await cronTriggers.runAnniversaryTriggers()

    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(1)
  })

  it('runEventReminderTriggers — an audience-check failure is contained to its own sequence', async () => {
    contactMatchesSequenceAudience.mockRejectedValueOnce(new Error('audience lookup failed'))
    const target = new Date(Date.now() + 24 * 3600_000)
    const booking = (id) => ({
      id, contact_id: `c-${id}`,
      booking_date: target.toISOString().slice(0, 10),
      start_time: target.toISOString().slice(11, 19),
      event_type_id: 'evt-A',
    })
    const db = mockDb({
      email_sequences: { list: [
        { id: 'seq-bad', location_id: 'loc-1', trigger_config: { hours_before: 24 }, audience_filter: null },
        { id: 'seq-good', location_id: 'loc-2', trigger_config: { hours_before: 24 }, audience_filter: null },
      ] },
      bookings: [{ list: [booking('b1')] }, { list: [booking('b2')] }],
      sequence_enrollments: { maybeSingle: null },
    })
    createServerClient.mockReturnValue(db)

    const stats = await cronTriggers.runEventReminderTriggers()

    expect(stats.errored).toBe(1)
    expect(stats.fired).toBe(1)
    expect(enrolContacts).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: 'seq-good' }))
    expect(logError).toHaveBeenCalledWith(
      'sequences',
      expect.stringContaining('seq-bad'),
      expect.objectContaining({ sequenceId: 'seq-bad' }),
    )
  })

  it('every runner reports errored: 0 on a clean tick', async () => {
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runEventReminderTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runAnniversaryTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0, errored: 0 })
  })

  // A misconfigured-but-active sequence does nothing on every tick,
  // forever. Before CRONISO.1 that was invisible in the stats (and, for
  // the numeric knobs and the unknown inactivity signal, not even
  // logged) — it counts as errored now.
  it('a config-rejected sequence is counted and logged, not silently skipped', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 'seq-no-days', location_id: 'loc-1', trigger_config: {}, audience_filter: null },
        { id: 'seq-bad-signal', location_id: 'loc-1', trigger_config: { signal: 'last_login_at', days_inactive: 30 }, audience_filter: null },
      ] },
    }))
    const stats = await cronTriggers.runInactivityTriggers()
    expect(stats.errored).toBe(2)
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringContaining('seq-no-days'), expect.objectContaining({ sequenceId: 'seq-no-days' }))
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringContaining('seq-bad-signal'), expect.objectContaining({ sequenceId: 'seq-bad-signal' }))
  })
})
