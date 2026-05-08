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
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('./audience.js', () => ({ contactMatchesSequenceAudience: vi.fn() }))
vi.mock('./enrol.js', () => ({ enrolContacts: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
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
 */
function mockDb(tables) {
  return {
    from: vi.fn((table) => {
      const t = tables[table]
      if (!t) throw new Error(`unexpected table: ${table}`)
      const cfg = Array.isArray(t) ? t.shift() : t
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: cfg.maybeSingle ?? null, error: null }),
        single: vi.fn().mockResolvedValue({ data: cfg.single ?? null, error: null }),
        then: (onF) => Promise.resolve({ data: cfg.list ?? [], error: null }).then(onF),
      }
      return builder
    }),
  }
}

// ── event_reminder ──────────────────────────────────────────────

describe('runEventReminderTriggers', () => {
  it('returns zero stats when there are no active event_reminder sequences', async () => {
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runEventReminderTriggers()).toEqual({ fired: 0, skipped: 0 })
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
    expect(await cronTriggers.runEventReminderTriggers()).toEqual({ fired: 0, skipped: 0 })
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
    expect(await cronTriggers.runAnniversaryTriggers()).toEqual({ fired: 0, skipped: 0 })
  })

  it('skips a sequence with non-numeric / negative days_after', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: {}, audience_filter: null },
        { id: 's2', location_id: 'loc-1', trigger_config: { days_after: 'soon' }, audience_filter: null },
        { id: 's3', location_id: 'loc-1', trigger_config: { days_after: -5 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runAnniversaryTriggers()).toEqual({ fired: 0, skipped: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('falls back to lead_created_at when from_field is not in the allowlist', async () => {
    let queriedField
    createServerClient.mockReturnValue({
      from: vi.fn((table) => {
        const builder = {
          select: vi.fn(function (cols) {
            // Capture which field was selected from contacts.
            if (table === 'contacts' && /id, /.test(cols)) {
              queriedField = cols.replace('id, ', '')
            }
            return this
          }),
          eq: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (onF) => Promise.resolve({
            data: table === 'email_sequences' ? [
              { id: 's1', location_id: 'loc-1', trigger_config: { from_field: 'created_at_im_evil', days_after: 30 }, audience_filter: null },
            ] : [],
            error: null,
          }).then(onF),
        }
        return builder
      }),
    })
    await cronTriggers.runAnniversaryTriggers()
    expect(queriedField).toBe('lead_created_at')
  })

  it('uses sourceRef = `${from_field}:${days_after}` for dedup', async () => {
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
      sourceRef: 'last_emailed_at:365',
    }))
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
    expect(stats).toEqual({ fired: 0, skipped: 1 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})

// ── inactivity ──────────────────────────────────────────────────

describe('runInactivityTriggers', () => {
  it('returns zero stats when no active sequences', async () => {
    createServerClient.mockReturnValue(mockDb({ email_sequences: { list: [] } }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0 })
  })

  it('skips a sequence with non-numeric / non-positive days_inactive', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: {}, audience_filter: null },
        { id: 's2', location_id: 'loc-1', trigger_config: { days_inactive: 0 }, audience_filter: null },
        { id: 's3', location_id: 'loc-1', trigger_config: { days_inactive: -7 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })

  it('skips a sequence with an unknown signal value', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_login_at', days_inactive: 30 }, audience_filter: null },
      ] },
    }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0 })
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

  it('derived last_booking_at: short-circuits when there are no contacts at the location', async () => {
    createServerClient.mockReturnValue(mockDb({
      email_sequences: { list: [
        { id: 's1', location_id: 'loc-1', trigger_config: { signal: 'last_booking_at', days_inactive: 60 }, audience_filter: null },
      ] },
      contacts: { list: [] },
    }))
    expect(await cronTriggers.runInactivityTriggers()).toEqual({ fired: 0, skipped: 0 })
    expect(enrolContacts).not.toHaveBeenCalled()
  })
})
