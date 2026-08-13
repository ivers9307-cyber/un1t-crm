// HYGREL.1 — the nightly sweep must not undo an operator release.
//
// This is the test the whole feature rests on. A released contact still
// satisfies every criterion the sweep tests — 3+ marketing sends in 90 days,
// zero opens, zero clicks, first send more than 90 days ago — because that is
// precisely why they were stamped in the first place. So an operator release
// that clears only contacts.email_suppressed_at survives until 05:15 and no
// longer, and the operator has no way to tell: the contact simply goes quiet
// again. contacts.email_hygiene_released_at (mig 535) is the gate, and it is
// only worth anything if it is in BOTH places the sweep touches the column.
//
// The db mock evaluates the filters rather than recording them, so these
// assertions fail if the filter is dropped OR if it is written against the
// wrong column — a recorded-call assertion would pass on a filter that names a
// column the fixture does not have.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

// Real thresholds and the real predicate; only the three email_sends fetchers
// are stubbed, so the sweep's own arithmetic still runs.
vi.mock('@/lib/email-hygiene', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    // Enough sends, in the window, for every candidate offered.
    fetchWindowMarketingSends: vi.fn(async (_db, ids) =>
      ids.flatMap((id) => [{ contact_id: id }, { contact_id: id }, { contact_id: id }])),
    // Nobody has opened or clicked anything.
    fetchEngagedContactIds: vi.fn(async () => new Set()),
    // Everybody's first send predates the window.
    fetchPreWindowSenderIds: vi.fn(async (_db, ids) => new Set(ids)),
  }
})

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'

const RELEASED_AT = '2026-08-12T09:00:00.000Z'

// Two contacts, identical in every respect the sweep scores on. The ONLY
// difference is that an operator released the second one.
const CONTACTS = () => [
  { id: 'c-never-released', email_marketing: true, email_suppressed_at: null, email_hygiene_released_at: null },
  { id: 'c-released', email_marketing: true, email_suppressed_at: null, email_hygiene_released_at: RELEASED_AT },
]

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op === 'eq') return row[col] === val
    if (op === 'is') return row[col] === val || (val === null && row[col] == null)
    if (op === 'in') return val.includes(row[col])
    if (op === 'gt') return String(row[col]) > String(val)
    return true
  })
}

function makeDb(rows = CONTACTS()) {
  const updates = []
  const db = {
    rows,
    updates,
    from(table) {
      const state = { table, op: 'select', filters: [], payload: null }
      const b = {
        select: () => b,
        update: (payload) => { state.op = 'update'; state.payload = payload; return b },
        eq: (c, v) => { state.filters.push(['eq', c, v]); return b },
        is: (c, v) => { state.filters.push(['is', c, v]); return b },
        in: (c, v) => { state.filters.push(['in', c, v]); return b },
        gt: (c, v) => { state.filters.push(['gt', c, v]); return b },
        not: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve) => {
          const hit = db.rows.filter((r) => matches(r, state.filters))
          if (state.op === 'update') {
            updates.push({ payload: state.payload, ids: hit.map((r) => r.id), filters: state.filters })
            for (const r of hit) Object.assign(r, state.payload)
            return resolve({ data: null, error: null })
          }
          return resolve({ data: hit.map((r) => ({ id: r.id })), error: null })
        },
      }
      return b
    },
  }
  return db
}

const req = () => new Request('https://x.test/api/cron/email-engagement-sweep', {
  headers: { authorization: 'Bearer shh' },
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
})

describe('email-engagement-sweep — an operator release is permanent', () => {
  it('never offers a released contact as a candidate', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    // One candidate scanned, one suppressed. The released contact was never
    // fetched, so it was never scored and never counted.
    expect(body.scanned).toBe(1)
    expect(body.suppressed).toBe(1)
    expect(db.rows.find((r) => r.id === 'c-released').email_suppressed_at).toBeNull()
    expect(db.rows.find((r) => r.id === 'c-never-released').email_suppressed_at).toEqual(expect.any(String))
  })

  it('re-asserts the release guard on the stamp itself, so a release granted mid-run wins', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await GET(req())

    const stamp = db.updates.find((u) => u.payload?.email_suppressed_at)
    expect(stamp).toBeTruthy()
    // The sweep can run for minutes. A release granted between the candidate
    // page and this write must not be undone by the pass already in flight.
    expect(stamp.filters).toContainEqual(['is', 'email_hygiene_released_at', null])
  })

  it('still suppresses everyone when nobody has been released', async () => {
    const db = makeDb(CONTACTS().map((r) => ({ ...r, email_hygiene_released_at: null })))
    createServerClient.mockReturnValue(db)

    const body = await (await GET(req())).json()
    expect(body.scanned).toBe(2)
    expect(body.suppressed).toBe(2)
  })
})

describe('email-engagement-sweep — auth', () => {
  it('401s without the cron secret', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await GET(new Request('https://x.test/', { headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    createServerClient.mockReturnValue(makeDb())
    expect((await GET(req())).status).toBe(401)
  })
})
