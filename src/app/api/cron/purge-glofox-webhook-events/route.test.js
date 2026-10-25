// GLOFOXEVENTRETENTION.1 (C47, CLEANUP-1) — the 90-day retention purge of
// glofox_webhook_events. Richard's call, 1 Oct 2026: purge rows older than 90
// days, daily.
//
// WHAT IT MUST AND MUST NOT DELETE:
//   • "older" is the row's LAST activity: received_at (first sight of the
//     Glofox entity; the upsert never rewrites it) AND processed_at (the
//     latest event's processing; NULL = never processed) are both past the
//     cutoff. An entity first seen 200 days ago whose latest event was
//     processed yesterday holds yesterday's data and stays.
//   • the delete CASCADES into glofox_webhook_attempts (mig 649), so a row
//     with ANY attempt processed inside the window stays — that history is
//     what C46 (GLOFOXDEDUP.1) reads.
//   • batched: PURGE_PAGE_SIZE ids per DELETE, at most MAX_ROWS_PER_RUN rows
//     per run; never one unbounded DELETE.
//   • fail closed: a failed read deletes nothing further, answers 500 and
//     does NOT stamp; a clean run (idle included) stamps.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import {
  GET, RETENTION_DAYS, PURGE_PAGE_SIZE, MAX_ROWS_PER_RUN, HEARTBEAT_NAME, retentionCutoff,
} from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { makeCleanupDb } from '../../../../../tests/helpers/cleanup-fake-db'

const NOW = Date.parse('2026-10-02T04:05:00Z')
const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const ago = (ms) => new Date(NOW - ms).toISOString()
const daysAgo = (d) => ago(d * DAY)
const CUTOFF = daysAgo(RETENTION_DAYS)

const EVENTS = 'glofox_webhook_events'
const ATTEMPTS = 'glofox_webhook_attempts'

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/purge-glofox-webhook-events', { headers: { authorization: `Bearer ${secret}` } })

const pad = (n) => String(n).padStart(12, '0')
const uuid = (n) => `00000000-0000-4000-8000-${pad(n)}`

function event(n, { received, processed = received, status = 'applied' } = {}) {
  return {
    id: uuid(n),
    event_id: `entity-${n}`,
    event_type: 'MEMBER_UPDATED',
    branch_id: 'branch-1',
    entity_id: `entity-${n}`,
    contact_email: null,
    payload: { Payload: { id: `entity-${n}` } },
    signature: null,
    status,
    result: { member_sync: { fields: ['redacted-in-fixture'] } },
    error_message: null,
    received_at: received,
    processed_at: processed,
  }
}

function attempt(id, eventN, processed) {
  return {
    id, event_row_id: uuid(eventN), location_id: 'loc-1', trace_id: `t-${id}`, event_type: 'MEMBER_UPDATED',
    emitted_at: processed, delivered_at: processed, processed_at: processed, status: 'applied', error_message: null, digest: {},
  }
}

let db
function setup({ events = [], attempts = [], errors = {} } = {}) {
  db = makeCleanupDb({
    tables: { [EVENTS]: events, [ATTEMPTS]: attempts },
    errors,
    cascades: [{ parent: EVENTS, child: ATTEMPTS, fk: 'event_row_id' }],
  })
  createServerClient.mockImplementation(() => db)
  return db
}

const remainingIds = (table = EVENTS) => db.tables[table].map((r) => r.id).sort()
const deletedFrom = (table) => db.deleted.filter((d) => d.table === table).map((d) => d.id).sort()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})
afterEach(() => { vi.useRealTimers() })

describe('auth', () => {
  it('401s without the secret and touches nothing', async () => {
    setup({ events: [event(1, { received: daysAgo(200) })] })
    expect((await GET(req('wrong'))).status).toBe(401)
    expect(db.calls).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    setup({ events: [event(1, { received: daysAgo(200) })] })
    expect((await GET(req())).status).toBe(401)
    expect(db.calls).toEqual([])
  })
})

describe('the constants', () => {
  it('retention is 90 days, pages are uuid-URL-safe, a run is capped at 1,000 rows', () => {
    expect(RETENTION_DAYS).toBe(90)
    expect(retentionCutoff(NOW)).toBe(CUTOFF)
    expect(PURGE_PAGE_SIZE).toBeLessThanOrEqual(200)
    expect(MAX_ROWS_PER_RUN).toBeLessThanOrEqual(1000)
    expect(MAX_ROWS_PER_RUN % PURGE_PAGE_SIZE).toBe(0)
    expect(HEARTBEAT_NAME).toBe('purge-glofox-webhook-events')
  })
})

describe('which rows go', () => {
  it('the 90-day boundary: a minute past it goes, a minute inside it stays (both clocks)', async () => {
    setup({
      events: [
        event(1, { received: ago(RETENTION_DAYS * DAY + MIN) }), // just past
        event(2, { received: ago(RETENTION_DAYS * DAY - MIN) }), // just inside
        event(3, { received: daysAgo(200), processed: ago(RETENTION_DAYS * DAY + MIN) }), // processed just past
        event(4, { received: daysAgo(200), processed: ago(RETENTION_DAYS * DAY - MIN) }), // processed just inside
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(deletedFrom(EVENTS)).toEqual([uuid(1), uuid(3)])
    expect(remainingIds()).toEqual([uuid(2), uuid(4)])
    const body = await res.json()
    expect(body.data).toMatchObject({ cutoff: CUTOFF, retention_days: 90, deleted: 2 })
  })

  it('an old entity whose latest event was processed recently stays (its row holds recent data)', async () => {
    setup({ events: [event(1, { received: daysAgo(150), processed: daysAgo(2) })] })
    await GET(req())
    expect(deletedFrom(EVENTS)).toEqual([])
  })

  it('an old row that was never processed (processed_at NULL) goes', async () => {
    setup({ events: [event(1, { received: daysAgo(120), processed: null, status: 'received' }), event(2, { received: daysAgo(5), processed: null, status: 'received' })] })
    await GET(req())
    expect(deletedFrom(EVENTS)).toEqual([uuid(1)])
  })

  it('keeps an old row with an attempt inside the window, so the cascade never eats recent attempt history', async () => {
    setup({
      events: [event(1, { received: daysAgo(150), processed: daysAgo(120) }), event(2, { received: daysAgo(150), processed: daysAgo(120) })],
      attempts: [attempt(10, 1, daysAgo(1)), attempt(11, 1, daysAgo(130)), attempt(20, 2, daysAgo(130))],
    })
    const body = await (await GET(req())).json()
    expect(deletedFrom(EVENTS)).toEqual([uuid(2)])
    // Row 2's own (old) attempt went with it by cascade; row 1 and BOTH its attempts stay.
    expect(remainingIds(ATTEMPTS)).toEqual([10, 11])
    expect(body.data.kept_recent_attempts).toBe(1)
  })

  it('every DELETE re-applies the retention predicate and targets explicit ids', async () => {
    setup({ events: [event(1, { received: daysAgo(200) })] })
    await GET(req())
    const del = db.calls.find((c) => c.op === 'delete')
    expect(del.filters).toEqual(expect.arrayContaining(['lt:received_at', `or:processed_at.is.null,processed_at.lt.${CUTOFF}`, 'in:id:1']))
  })
})

describe('batching', () => {
  const many = (n, from = 1) => Array.from({ length: n }, (_, i) => event(from + i, { received: daysAgo(100 + (i % 50)) }))

  it('deletes at most MAX_ROWS_PER_RUN per run, PURGE_PAGE_SIZE per DELETE, oldest first, and reports the cap', async () => {
    setup({ events: many(MAX_ROWS_PER_RUN + 250) })
    const body = await (await GET(req())).json()
    const deletes = db.calls.filter((c) => c.op === 'delete')
    expect(deletes.length).toBe(MAX_ROWS_PER_RUN / PURGE_PAGE_SIZE)
    for (const d of deletes) expect(d.inSizes[0]).toBeLessThanOrEqual(PURGE_PAGE_SIZE)
    expect(deletedFrom(EVENTS)).toHaveLength(MAX_ROWS_PER_RUN)
    expect(db.tables[EVENTS]).toHaveLength(250)
    expect(body.data).toMatchObject({ deleted: MAX_ROWS_PER_RUN, cap_reached: true })
    // Oldest first: every row left is no older than the youngest deleted one.
    const scans = db.calls.filter((c) => c.table === EVENTS && c.op === 'select')
    for (const s of scans) expect(s.orders).toEqual(['received_at', 'id'])
    // A capped run is still a healthy run.
    expect(stampHeartbeat).toHaveBeenCalledWith(HEARTBEAT_NAME, expect.objectContaining({ cap_reached: true }))
  })

  it('drains a backlog smaller than the cap in one run', async () => {
    setup({ events: [...many(PURGE_PAGE_SIZE + 7), event(9999, { received: daysAgo(3) })] })
    const body = await (await GET(req())).json()
    expect(body.data).toMatchObject({ deleted: PURGE_PAGE_SIZE + 7, cap_reached: false })
    expect(remainingIds()).toEqual([uuid(9999)])
  })

  it('pages PAST rows kept for recent attempts instead of re-reading them forever', async () => {
    const events = many(PURGE_PAGE_SIZE + 10)
    // The oldest PURGE_PAGE_SIZE rows all have a recent attempt.
    const sorted = [...events].sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : a.id < b.id ? -1 : 1))
    const attempts = sorted.slice(0, PURGE_PAGE_SIZE).map((e, i) => ({ ...attempt(i + 1, 0, daysAgo(1)), event_row_id: e.id }))
    setup({ events, attempts })
    const body = await (await GET(req())).json()
    expect(body.data.kept_recent_attempts).toBe(PURGE_PAGE_SIZE)
    expect(body.data.deleted).toBe(10)
    expect(db.tables[ATTEMPTS]).toHaveLength(PURGE_PAGE_SIZE)
  })

  it('the attempt guard read pages past the 1,000-row select cap', async () => {
    // Two candidates: row 1 has 1,000 recent attempts, row 2 has one, ordered
    // after them. An unpaged guard read stops at the cap, never sees row 2's
    // attempt, and would let the cascade delete it.
    const events = [event(1, { received: daysAgo(150), processed: daysAgo(120) }), event(2, { received: daysAgo(150), processed: daysAgo(120) })]
    const attempts = [
      ...Array.from({ length: 1000 }, (_, i) => ({ ...attempt(i + 1, 1, daysAgo(1)) })),
      attempt(5000, 2, daysAgo(1)),
    ]
    setup({ events, attempts })
    await GET(req())
    expect(deletedFrom(EVENTS)).toEqual([])
    const guardReads = db.calls.filter((c) => c.table === ATTEMPTS && c.op === 'select')
    expect(guardReads.length).toBeGreaterThan(1)
    for (const g of guardReads) expect(g.range).not.toBeNull()
  })
})

describe('failure is closed', () => {
  it('a failed candidate read deletes nothing, answers 500 and does NOT stamp', async () => {
    setup({ events: [event(1, { received: daysAgo(200) })], errors: { [EVENTS]: { select: { message: 'boom' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(db.deleted).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect((await res.json()).success).toBe(false)
  })

  it('a failed attempt-guard read deletes nothing, answers 500 and does NOT stamp', async () => {
    setup({ events: [event(1, { received: daysAgo(200) })], errors: { [ATTEMPTS]: { select: { message: 'guard down' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(db.deleted).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed delete answers 500 and does NOT stamp', async () => {
    setup({ events: [event(1, { received: daysAgo(200) })], errors: { [EVENTS]: { delete: { message: 'locked' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a later page failing keeps what earlier pages did, stops, and does NOT stamp', async () => {
    let scans = 0
    const events = Array.from({ length: PURGE_PAGE_SIZE + 5 }, (_, i) => event(i + 1, { received: daysAgo(150) }))
    setup({ events, errors: { [EVENTS]: { select: () => (++scans === 2 ? { message: 'second page down' } : null) } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(deletedFrom(EVENTS)).toHaveLength(PURGE_PAGE_SIZE)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('heartbeat', () => {
  it('an idle run (nothing past retention) stamps with the outcome', async () => {
    setup({ events: [event(1, { received: daysAgo(10) })] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(db.deleted).toEqual([])
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith(HEARTBEAT_NAME, expect.objectContaining({ cutoff: CUTOFF, deleted: 0, cap_reached: false }))
  })
})
