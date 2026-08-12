// HYGREL.1 — the engagement sweep must skip a contact an operator released.
//
// This is the one assertion that keeps mig 535 meaningful. A released contact
// still satisfies every suppression criterion (>=3 marketing sends in the
// window, zero opens, zero clicks, first send before the window), so if the
// candidate query stops filtering on email_hygiene_released_at the release is
// undone by the very next nightly run — silently, and with no audit row on the
// re-suppression. That failure would look exactly like nothing happening,
// which is why it is pinned here rather than left to review.
//
// DB stubbed per the cron route-test convention (see checklist-sweep).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Records every filter applied per table so the test can assert the shape of
// the candidate query rather than just its result.
let calls = []
let tables = {}

function makeBuilder(table) {
  const b = {}
  for (const m of ['select', 'order', 'limit', 'gt', 'in', 'lt', 'gte', 'range', 'update']) {
    b[m] = (...args) => { calls.push({ table, method: m, args }); return b }
  }
  b.eq = (col, val) => { calls.push({ table, method: 'eq', args: [col, val] }); return b }
  b.is = (col, val) => { calls.push({ table, method: 'is', args: [col, val] }); return b }
  b.not = (col, op, val) => { calls.push({ table, method: 'not', args: [col, op, val] }); return b }
  b.then = (resolve) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve)
  return b
}

const fakeDb = { from: (t) => makeBuilder(t) }

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

import { GET } from './route.js'

const req = () => new Request('https://x.test/api/cron/email-engagement-sweep', {
  headers: { authorization: 'Bearer test-secret' },
})

describe('email-engagement-sweep — operator releases are permanent (HYGREL.1)', () => {
  beforeEach(() => {
    calls = []
    tables = {}
    process.env.CRON_SECRET = 'test-secret'
  })

  it('excludes contacts carrying email_hygiene_released_at from the candidate query', async () => {
    await GET(req())

    const contactFilters = calls.filter((c) => c.table === 'contacts' && c.method === 'is')
    const cols = contactFilters.map((c) => c.args[0])

    expect(cols).toContain('email_hygiene_released_at')
    // Null-check, not a truthiness test: a released contact has a timestamp,
    // and only `IS NULL` selects the never-released population.
    const released = contactFilters.find((c) => c.args[0] === 'email_hygiene_released_at')
    expect(released.args[1]).toBeNull()
  })

  it('still excludes the already-suppressed, so the two gates are independent', async () => {
    await GET(req())

    const cols = calls
      .filter((c) => c.table === 'contacts' && c.method === 'is')
      .map((c) => c.args[0])

    // Both must be present. Losing either one re-stamps a population that was
    // deliberately taken out of scope.
    expect(cols).toContain('email_suppressed_at')
    expect(cols).toContain('email_hygiene_released_at')
  })

  it('refuses without the cron secret, before any query runs', async () => {
    const res = await GET(new Request('https://x.test/api/cron/email-engagement-sweep'))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })
})
