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

  it('lead_status: true when contact.lead_status === value', async () => {
    expect(
      await isGoalMet({
        db: {},
        contact: { lead_status: 'member' },
        goalConfig: { type: 'lead_status', value: 'member' },
      }),
    ).toBe(true)
    expect(
      await isGoalMet({
        db: {},
        contact: { lead_status: 'trial' },
        goalConfig: { type: 'lead_status', value: 'member' },
      }),
    ).toBe(false)
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
