// Tests for the post-class email composer + sender. composeEmail
// is pure so most tests hit it directly. sendPostClassEmail is
// tested with mocked Supabase + Postmark to confirm orchestration.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendTransactionalEmail: vi.fn(),
}))

import { composeEmail, sendPostClassEmail, loadContextForSession } from './hr-post-class-email.js'
import { sendTransactionalEmail } from '@/lib/postmark'

const NOW = new Date('2026-05-08T19:00:00Z').getTime()

function ctx({
  thisPoints = 100,
  thisPeak = 175,
  thisAvg = 145,
  thisZones = { 1: 60, 2: 600, 3: 1200, 4: 600, 5: 0 },
  history = [],
  contactName = 'Sarah Test',
  eventTypeName = 'RIDE',
  startedAt = '2026-05-08T18:00:00Z',
  endedAt = '2026-05-08T18:45:00Z',
} = {}) {
  return {
    ok: true,
    session: {
      id: 'sess-1',
      contact_id: 'c-1',
      location_id: 'loc-1',
      booking_id: 'b-1',
      started_at: startedAt,
      ended_at: endedAt,
      max_hr_used: 200,
      avg_hr_bpm: thisAvg,
      peak_hr_bpm: thisPeak,
      zones_seconds: thisZones,
      effort_points: thisPoints,
    },
    thisSession: {
      id: 'sess-1',
      started_at: startedAt,
      event_type_id: 'evt-RIDE',
      class_name: eventTypeName,
      category: null,
      effort_points: thisPoints,
      peak_hr_bpm: thisPeak,
      avg_hr_bpm: thisAvg,
      zones_seconds: thisZones,
    },
    history,
    eventTypeName,
    contact: { id: 'c-1', name: contactName, email: 'sarah@test.com', hr_post_class_emails_enabled: true },
  }
}

beforeEach(() => { vi.clearAllMocks() })

// ── composeEmail ────────────────────────────────────────────────

describe('composeEmail', () => {
  it('produces subject + text + html for a baseline session', () => {
    const out = composeEmail(ctx(), { nowMs: NOW })
    expect(out.subject).toBeTruthy()
    expect(out.text).toContain('Hi Sarah,')
    expect(out.text).toContain('UN1T Points')
    expect(out.html).toContain('<html>')
    expect(out.html).toContain('Sarah')
  })

  it('subject reflects highlight: first_ever for new member', () => {
    const out = composeEmail(ctx({ history: [] }), { nowMs: NOW })
    expect(out.subject).toMatch(/Welcome/)
  })

  it('subject reflects highlight: new_peak when prior peaks were lower', () => {
    const out = composeEmail(ctx({
      thisPeak: 195,
      history: [
        { id: 'p1', started_at: '2026-04-20T18:00:00Z', event_type_id: 'evt-RIDE', class_name: 'RIDE', effort_points: 100, peak_hr_bpm: 170, avg_hr_bpm: 140, zones_seconds: { 5: 0 } },
        { id: 'p2', started_at: '2026-04-25T18:00:00Z', event_type_id: 'evt-RIDE', class_name: 'RIDE', effort_points: 100, peak_hr_bpm: 175, avg_hr_bpm: 140, zones_seconds: { 5: 0 } },
      ],
    }), { nowMs: NOW })
    expect(out.subject).toMatch(/peak HR/i)
  })

  it('subject default: "Your <class> — N UN1T Points"', () => {
    // No highlight should fire — points 100, 10 prior RIDE sessions
    // also at 100 points and peak 180 (so this session's 175 doesn't
    // beat them), no streak (sessions every 3 days, not consecutive).
    const history = Array.from({ length: 10 }).map((_, i) => ({
      id: `p${i}`,
      started_at: new Date(NOW - (10 + i * 3) * 24 * 3600 * 1000).toISOString(),
      event_type_id: 'evt-RIDE',
      class_name: 'RIDE',
      effort_points: 100, peak_hr_bpm: 180, avg_hr_bpm: 140, zones_seconds: { 5: 0 },
    }))
    const out = composeEmail(ctx({ history }), { nowMs: NOW })
    expect(out.subject).toMatch(/RIDE/i)
    expect(out.subject).toMatch(/100/)
  })

  it('HTML includes zone breakdown rows for each non-zero zone', () => {
    const out = composeEmail(ctx(), { nowMs: NOW })
    // Z2/Z3/Z4 are non-zero in the default fixture
    expect(out.html).toContain('Easy')
    expect(out.html).toContain('Aerobic')
    expect(out.html).toContain('Threshold')
  })

  it('HTML includes a stop-emails link', () => {
    const out = composeEmail(ctx(), { nowMs: NOW })
    expect(out.html).toContain('/api/preferences/hr-emails')
    expect(out.html).toContain('cid=c-1')
  })

  it('text includes total UN1T Points in headline', () => {
    const out = composeEmail(ctx({ thisPoints: 187 }), { nowMs: NOW })
    expect(out.text).toMatch(/187 UN1T Points/)
  })

  it('analytics.classType.percentile shows up as "top X%" copy when high', () => {
    // 8 prior RIDE sessions with low points so this 200-pt one is top quartile.
    const history = Array.from({ length: 8 }).map((_, i) => ({
      id: `p${i}`,
      started_at: new Date(NOW - (5 + i) * 24 * 3600 * 1000).toISOString(),
      event_type_id: 'evt-RIDE',
      class_name: 'RIDE',
      effort_points: 80 + i, peak_hr_bpm: 170, avg_hr_bpm: 140, zones_seconds: { 5: 0 },
    }))
    const out = composeEmail(ctx({ thisPoints: 200, history }), { nowMs: NOW })
    expect(out.text + out.html).toMatch(/Top \d+%/)
  })
})

// ── sendPostClassEmail ─────────────────────────────────────────

describe('sendPostClassEmail', () => {
  // Build a minimal Supabase mock that returns canned shapes for
  // the three select calls + an update.
  function mockDb({ session, history = [], stampError = null }) {
    return {
      from: vi.fn((table) => {
        if (table === 'class_categories') {
          // No category mappings in test context — degrades gracefully to null categories.
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
            })),
          }
        }
        if (table === 'locations') {
          // Return empty customer_agent settings — CTA will be null (no booking_url set).
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: { settings: {} }, error: null })),
              })),
            })),
          }
        }
        if (table === 'heart_rate_sessions') {
          return {
            select: vi.fn((cols) => {
              // Call 1 in loadContextForSession: .single() on a session lookup.
              // Call 2 in loadContextForSession: list query for history.
              // Call 3 in sendPostClassEmail: .update(...).eq(...) for the email_sent_at stamp.
              if (cols.includes('contact:contacts')) {
                return {
                  eq: vi.fn(() => ({
                    single: vi.fn(() => Promise.resolve({ data: session, error: session ? null : { message: 'not found' } })),
                  })),
                }
              }
              return {
                eq: vi.fn(() => ({
                  gte: vi.fn(() => ({
                    not: vi.fn(() => Promise.resolve({ data: history, error: null })),
                  })),
                })),
              }
            }),
            update: vi.fn(() => ({
              eq: vi.fn(() => Promise.resolve({ error: stampError })),
            })),
          }
        }
        throw new Error(`unexpected table ${table}`)
      }),
    }
  }

  function fullSessionRow(overrides = {}) {
    return {
      id: 'sess-1',
      contact_id: 'c-1',
      location_id: 'loc-1',
      booking_id: 'b-1',
      started_at: '2026-05-08T18:00:00Z',
      ended_at: '2026-05-08T18:45:00Z',
      max_hr_used: 200,
      avg_hr_bpm: 145,
      peak_hr_bpm: 175,
      zones_seconds: { 1: 60, 2: 600, 3: 1200, 4: 600, 5: 0 },
      effort_points: 100,
      email_sent_at: null,
      source: 'ble_bridge',
      device_identifier: 'AA:BB:CC:DD:EE:FF',
      contact: { id: 'c-1', name: 'Sarah Test', email: 'sarah@test.com', hr_post_class_emails_enabled: true },
      booking: { id: 'b-1', booking_date: '2026-05-08', start_time: '18:00:00',
        event_type: { id: 'evt-RIDE', name: 'RIDE' } },
      ...overrides,
    }
  }

  it('sends and stamps email_sent_at on the happy path', async () => {
    sendTransactionalEmail.mockResolvedValue({ messageId: 'pm-1' })
    const db = mockDb({ session: fullSessionRow() })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual(expect.objectContaining({ ok: true, sent: true }))
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail.mock.calls[0][0]).toEqual(expect.objectContaining({
      to: 'sarah@test.com',
      tag: 'hr-post-class',
      contactId: 'c-1',
      locationId: 'loc-1',
    }))
  })

  it('skips when contact opted out', async () => {
    const db = mockDb({
      session: fullSessionRow({ contact: { id: 'c-1', name: 'Sarah Test', email: 'sarah@test.com', hr_post_class_emails_enabled: false } }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'opted-out' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('skips when contact has no email', async () => {
    const db = mockDb({
      session: fullSessionRow({ contact: { id: 'c-1', name: 'Sarah Test', email: null, hr_post_class_emails_enabled: true } }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'no-email' })
  })

  it('skips when email_sent_at is already set (idempotent)', async () => {
    const db = mockDb({
      session: fullSessionRow({ email_sent_at: '2026-05-08T18:50:00Z' }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'already-sent' })
  })

  it('skips when zones_seconds adds up to <60s (data too thin)', async () => {
    const db = mockDb({
      session: fullSessionRow({ zones_seconds: { 1: 20, 2: 0, 3: 0, 4: 0, 5: 0 } }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'too-little-data' })
  })

  it('reports error when session not found', async () => {
    const db = mockDb({ session: null })
    const out = await sendPostClassEmail(db, 'sess-missing', { nowMs: NOW })
    expect(out.ok).toBe(false)
  })
})

// ── loadContextForSession ──────────────────────────────────────

describe('loadContextForSession', () => {
  it('returns alreadySent when email_sent_at is set', async () => {
    const session = { id: 's', ended_at: '2026-05-08T18:45:00Z', email_sent_at: '2026-05-08T18:50:00Z' }
    const db = {
      from: vi.fn((table) => {
        // Only heart_rate_sessions is reached before the early-return on alreadySent
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: session, error: null })),
            })),
          })),
        }
      }),
    }
    const out = await loadContextForSession(db, 's')
    expect(out).toEqual({ ok: false, error: 'already-sent', alreadySent: true })
  })
})
