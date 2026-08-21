// Tests for the post-class email composer + sender. composeEmail
// is pure so most tests hit it directly. sendPostClassEmail is
// tested with mocked Supabase + Postmark to confirm orchestration.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({
  sendTransactionalEmail: vi.fn(),
}))

import { composeEmail, sendPostClassEmail, loadContextForSession } from './hr-post-class-email.js'
import { sendTransactionalEmail } from '@/lib/postmark'

const NOW = new Date('2026-05-08T19:00:00Z').getTime()

// HRPREF-AUTH.1 — contact_preferences.unsubscribe_token (mig 005 mints one
// UUID per contact); the composer embeds it in the stop-emails link.
const UNSUB_TOKEN = '9f1c7c0e-0000-4000-8000-0000000000aa'

function ctx({
  unsubscribeToken = UNSUB_TOKEN,
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
    unsubscribeToken,
  }
}

// URLSEAM.1 — the unsubscribe base now comes from getAppUrl(), which THROWS
// when NEXT_PUBLIC_APP_URL is unset (CLAUDE.md: no silent env fallbacks).
// Every compose in this file therefore needs the CRM host configured, the
// same way prod configures it. The dedicated seam suite below overrides it.
const CRM_HOST = 'https://crm.repset.ie'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', CRM_HOST)
})

afterEach(() => { vi.unstubAllEnvs() })

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

  // HRPREF-AUTH.1 — the stop-emails link now carries the per-contact
  // capability token, not the raw contact id. A contact id is an identifier
  // that leaks through exports, logs and support threads; the token is a
  // credential minted per contact by mig 005, and it is what every sibling
  // public preference endpoint authenticates with.
  it('HTML includes a stop-emails link carrying the unsubscribe token', () => {
    const out = composeEmail(ctx(), { nowMs: NOW })
    expect(out.html).toContain('/api/preferences/hr-emails')
    expect(out.html).toContain(`token=${UNSUB_TOKEN}`)
    expect(out.html).not.toContain('cid=c-1')
  })

  // REPSET-P6.C — the session CTA is a MEMBER link and must build on the
  // member-app base, never on this repo's own NEXT_PUBLIC_APP_URL (the CRM
  // host, which has no /sessions route — every CTA 404'd in prod).
  it('session CTA builds on the member-app base in both HTML and text', () => {
    const out = composeEmail(ctx(), { nowMs: NOW })
    // REPSET-P6.S2 — code default flipped to the canonical repset member host.
    expect(out.html).toContain('https://api.repset.ie/sessions/sess-1')
    expect(out.text).toContain('https://api.repset.ie/sessions/sess-1')
  })

  it('unsubscribe link stays on the CRM base', () => {
    const out = composeEmail(ctx(), { nowMs: NOW })
    // REPSET-P6.S2 — code default flipped to the canonical repset CRM host.
    expect(out.html).toContain('https://crm.repset.ie/api/preferences/hr-emails')
  })
})

// URLSEAM.1 — this email crosses TWO hosts (member CTA vs CRM unsubscribe).
// Both bases are resolved per call now, so stubbing the env is enough; the
// old module-reimport dance is gone with the module-level consts.
describe('composeEmail — URL bases vs env', () => {
  const compose = (env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    return composeEmail(ctx(), { nowMs: NOW })
  }

  afterEach(() => { vi.unstubAllEnvs() })

  // The live bug (#1444): in THIS repo NEXT_PUBLIC_APP_URL is the CRM host.
  // The old code built the session CTA on it → 404 in every email.
  it('prod config (NEXT_PUBLIC_APP_URL = CRM host): CTA still on the member app', () => {
    const out = compose({ NEXT_PUBLIC_APP_URL: 'https://crm.repset.ie' })
    expect(out.html).toContain('https://api.repset.ie/sessions/sess-1')
    expect(out.text).toContain('https://api.repset.ie/sessions/sess-1')
    expect(out.html).not.toContain('https://crm.repset.ie/sessions/')
  })

  it('NEXT_PUBLIC_CHAMP_APP_URL overrides the member-app base (same var invite-app uses)', () => {
    const out = compose({
      NEXT_PUBLIC_APP_URL: 'https://crm.un1tdublin.com',
      NEXT_PUBLIC_CHAMP_APP_URL: 'https://members.example.com',
    })
    expect(out.html).toContain('https://members.example.com/sessions/sess-1')
    expect(out.text).toContain('https://members.example.com/sessions/sess-1')
  })

  // ── the defect ────────────────────────────────────────────────
  // The unsubscribe endpoint is served by THIS deployment, so the base has
  // to follow THIS deployment's env var. It used to read
  // NEXT_PUBLIC_APP_URL_CRM — a var set on no deployment in this repo — so
  // it always fell through to a literal and silently ignored the seam.
  it('unsubscribe base follows NEXT_PUBLIC_APP_URL (the CRM seam)', () => {
    const out = compose({ NEXT_PUBLIC_APP_URL: 'https://crm.example.com' })
    expect(out.html).toContain('https://crm.example.com/api/preferences/hr-emails')
  })

  it('a preview host is followed, not overridden by a hard-coded default', () => {
    const out = compose({ NEXT_PUBLIC_APP_URL: 'https://un1t-crm-git-x.vercel.app' })
    expect(out.html).toContain('https://un1t-crm-git-x.vercel.app/api/preferences/hr-emails')
    expect(out.html).not.toContain('crm.repset.ie')
  })

  // The phantom var must have NO effect any more. If someone re-introduces
  // the old read, this fails.
  it('NEXT_PUBLIC_APP_URL_CRM is a phantom var and drives nothing', () => {
    const out = compose({
      NEXT_PUBLIC_APP_URL: 'https://crm.example.com',
      NEXT_PUBLIC_APP_URL_CRM: 'https://phantom.example.com',
    })
    expect(out.html).not.toContain('phantom.example.com')
    expect(out.html).toContain('https://crm.example.com/api/preferences/hr-emails')
  })

  it('throws instead of guessing a host when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(() => composeEmail(ctx(), { nowMs: NOW })).toThrow(/NEXT_PUBLIC_APP_URL is not set/)
  })

  // Belt and braces: one contact in prod has no contact_preferences row, and a
  // future import could create more. The email must still ship a working link,
  // so the builder falls back to the legacy cid+sid PAIR (which the endpoint
  // still accepts, because the session has to belong to the contact).
  it('falls back to the cid+sid pair when the contact has no token', () => {
    const out = composeEmail(ctx({ unsubscribeToken: null }), { nowMs: NOW })
    expect(out.html).toContain('cid=c-1')
    expect(out.html).toContain('sid=sess-1')
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
  function mockDb({ session, history = [], stampError = null, claimedRows = [{ id: 'sess-1' }], unsubscribeToken = UNSUB_TOKEN }) {
    // Records every email_sent_at stamp (real send OR permanent-skip
    // markProcessed) so tests can assert the row leaves the auto-end sweep.
    const stamps = []
    const db = {
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
          // Return empty customer_agent settings — CTA will be null (no membership_signup_url set).
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
            update: vi.fn((payload) => {
              stamps.push(payload)
              // Two shapes: markProcessed → .update().eq() (thenable), and the
              // item-5 claim → .update().eq().is().select() returning claimed
              // rows. `claimedRows` defaults to one row (claim wins).
              const claimResult = Promise.resolve({ data: claimedRows, error: stampError })
              const eqNode = {
                then: (res) => Promise.resolve({ error: stampError }).then(res),
                is: vi.fn(() => ({ select: vi.fn(() => claimResult) })),
              }
              return { eq: vi.fn(() => eqNode) }
            }),
          }
        }
        // HRPREF-AUTH.1 — loadContextForSession now also fetches the contact's
        // unsubscribe_token, which the stop-emails link carries instead of the
        // raw contact id.
        if (table === 'contact_preferences') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(() => Promise.resolve({
                  data: unsubscribeToken ? { unsubscribe_token: unsubscribeToken } : null,
                  error: null,
                })),
              })),
            })),
          }
        }
        throw new Error(`unexpected table ${table}`)
      }),
    }
    db.__stamps = stamps
    return db
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
    expect(db.__stamps).toHaveLength(1) // email_sent_at stamped on send
  })

  it('skips when contact opted out', async () => {
    const db = mockDb({
      session: fullSessionRow({ contact: { id: 'c-1', name: 'Sarah Test', email: 'sarah@test.com', hr_post_class_emails_enabled: false } }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'opted-out' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.__stamps).toHaveLength(1) // marked processed so it leaves the sweep
  })

  it('skips when contact has no email', async () => {
    const db = mockDb({
      session: fullSessionRow({ contact: { id: 'c-1', name: 'Sarah Test', email: null, hr_post_class_emails_enabled: true } }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'no-email' })
    expect(db.__stamps).toHaveLength(1) // marked processed so it leaves the sweep
  })

  it('skips when email_sent_at is already set (idempotent)', async () => {
    const db = mockDb({
      session: fullSessionRow({ email_sent_at: '2026-05-08T18:50:00Z' }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'already-sent' })
    expect(db.__stamps).toHaveLength(0) // already stamped; don't re-stamp
  })

  it('skips when zones_seconds adds up to <60s (data too thin)', async () => {
    const db = mockDb({
      session: fullSessionRow({ zones_seconds: { 1: 20, 2: 0, 3: 0, 4: 0, 5: 0 } }),
    })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'too-little-data' })
    expect(db.__stamps).toHaveLength(1) // marked processed so it leaves the sweep (the spam fix)
  })

  it('reports error when session not found', async () => {
    const db = mockDb({ session: null })
    const out = await sendPostClassEmail(db, 'sess-missing', { nowMs: NOW })
    expect(out.ok).toBe(false)
  })

  // Item 3 — a test-mode session must never email; it's marked processed so it
  // leaves the auto-end sweep (and its "session ready" push never fires).
  it('skips (marks processed) a test-mode session without sending', async () => {
    const db = mockDb({ session: fullSessionRow({ raw_metadata: { test_mode: true } }) })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'test-mode' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(db.__stamps).toHaveLength(1) // markProcessed stamp
  })

  // Item 5 — claim-before-send: if a concurrent path already claimed the row
  // (our UPDATE … WHERE email_sent_at IS NULL affects 0 rows), we must NOT send.
  it('does not double-send when the claim affects no rows (already claimed)', async () => {
    sendTransactionalEmail.mockResolvedValue({ messageId: 'pm-1' })
    const db = mockDb({ session: fullSessionRow(), claimedRows: [] }) // claim lost
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out).toEqual({ ok: true, skipped: 'already-sent' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  // URLSEAM.1 review — the counterpart to "getAppUrl throws instead of
  // guessing a host". A throwing compose must still take the row OUT of the
  // auto-end sweep: the sweep re-selects every session with
  // `email_sent_at IS NULL` on a 5-minute tick, and composeEmail is a pure
  // function of the loaded ctx + env, so a throw repeats identically forever.
  // Without the stamp the fix for one silent failure creates a louder one — a
  // "session ready" push every 5 minutes to a member's phone.
  it('a throwing compose still leaves the auto-end sweep (no 5-minute re-push loop)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '') // unsubscribeUrl → getAppUrl() throws
    const db = mockDb({ session: fullSessionRow() })
    const out = await sendPostClassEmail(db, 'sess-1', { nowMs: NOW })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/NEXT_PUBLIC_APP_URL is not set/)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    // The whole point: stamped exactly once, so the next sweep tick skips it.
    expect(db.__stamps).toHaveLength(1)
    expect(db.__stamps[0]).toEqual(
      expect.objectContaining({ email_sent_at: new Date(NOW).toISOString() }),
    )
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
