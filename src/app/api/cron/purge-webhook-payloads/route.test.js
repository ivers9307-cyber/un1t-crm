// WEBHOOK-RETENTION.1 — the 90-day retention purge of FINISHED webhook
// payload rows.
//
// WHAT IT MUST AND MUST NOT DELETE:
//   • webhook_dead_letter (mig 315): a row whose status is 'resolved' or
//     'discarded' AND whose resolved_at is older than RETENTION_DAYS — nothing
//     else. A young finished row waits; a 'pending' or 'failed' row of ANY age
//     is never touched (it is the morgue's live work).
//   • postmark_webhook_queue (mig 158, no status column): a row whose
//     processed_at is set AND older than RETENTION_DAYS — nothing else. An
//     unprocessed row (processed_at NULL) of any age is never touched, and
//     that includes an EXHAUSTED row (attempts >= MAX_ATTEMPTS, processed_at
//     still NULL — POSTMARK-DLQ.1) and a stale claim (processed_at set but
//     `error` still carrying CLAIMED_ERROR_MARKER — POSTMARK-QUEUE-RECLAIM.1),
//     which is an UNFINISHED event wearing a finished timestamp.
//   • pages with .range() and an explicit .order() — every select caps at
//     1,000 rows whatever the code asks for.
//   • collects failures PER TABLE: a broken delete on one table still purges
//     the other, answers 500, and does NOT stamp the heartbeat.
//   • stamps the heartbeat on a clean run and ONLY on a clean run.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import { GET, RETENTION_DAYS, PURGE_PAGE_SIZE, retentionCutoff } from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { CLAIMED_ERROR_MARKER, EXHAUSTED_ERROR_PREFIX, MAX_ATTEMPTS } from '@/lib/postmark-queue'
import { makeDb, deletesFrom } from '../../email/tickets/_test-db'

const NOW = Date.parse('2026-09-05T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString()
const CUTOFF = new Date(NOW - RETENTION_DAYS * DAY).toISOString()

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/purge-webhook-payloads', { headers: { authorization: `Bearer ${secret}` } })

const PAYLOAD = { From: 'erased.member@example.com', Subject: 'hello', TextBody: 'the body' }

function deadLetter(id, status, { resolvedDaysAgo = null, receivedDaysAgo = 200 } = {}) {
  return {
    id,
    provider: 'postmark_inbound',
    event_type: 'inbound',
    payload: PAYLOAD,
    error: null,
    attempts: 1,
    status,
    received_at: daysAgo(receivedDaysAgo),
    last_attempt_at: null,
    resolved_at: resolvedDaysAgo === null ? null : daysAgo(resolvedDaysAgo),
    location_id: null,
  }
}

function queueRow(id, { processedDaysAgo = null, receivedDaysAgo = 200, attempts = 1, error = null } = {}) {
  return {
    id,
    payload: PAYLOAD,
    received_at: daysAgo(receivedDaysAgo),
    processed_at: processedDaysAgo === null ? null : daysAgo(processedDaysAgo),
    error,
    attempts,
  }
}

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

const ids = (rows) => rows.map(r => r.id).sort()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})

describe('auth', () => {
  it('401s without the secret and touches nothing', async () => {
    setupDb({ deadLetters: [deadLetter('d-old', 'resolved', { resolvedDaysAgo: 200 })] })
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db.deletes).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    setupDb({ deadLetters: [deadLetter('d-old', 'resolved', { resolvedDaysAgo: 200 })] })
    expect((await GET(req())).status).toBe(401)
    expect(db.deletes).toEqual([])
  })
})

describe('the cutoff', () => {
  it('is RETENTION_DAYS = 90 days before now, and the run reports it', async () => {
    expect(RETENTION_DAYS).toBe(90)
    expect(retentionCutoff(NOW)).toBe(CUTOFF)
    setupDb({})
    const body = await (await GET(req())).json()
    expect(body.data.cutoff).toBe(CUTOFF)
    expect(body.data.retention_days).toBe(RETENTION_DAYS)
  })

  it('a row one day past the cutoff goes; one day inside it stays', async () => {
    setupDb({
      deadLetters: [
        deadLetter('d-91', 'resolved', { resolvedDaysAgo: RETENTION_DAYS + 1 }),
        deadLetter('d-89', 'resolved', { resolvedDaysAgo: RETENTION_DAYS - 1 }),
      ],
      webhookQueue: [
        queueRow('q-91', { processedDaysAgo: RETENTION_DAYS + 1 }),
        queueRow('q-89', { processedDaysAgo: RETENTION_DAYS - 1 }),
      ],
    })
    const body = await (await GET(req())).json()
    expect(body.data.deleted).toEqual({ webhook_dead_letter: 1, postmark_webhook_queue: 1 })
    expect(ids(db._state.deadLetters)).toEqual(['d-89'])
    expect(ids(db._state.webhookQueue)).toEqual(['q-89'])
  })
})

describe('webhook_dead_letter — what gets purged', () => {
  it('deletes only resolved/discarded rows whose resolved_at is older than the cutoff', async () => {
    setupDb({
      deadLetters: [
        deadLetter('d-resolved-old', 'resolved', { resolvedDaysAgo: 200 }),
        deadLetter('d-discarded-old', 'discarded', { resolvedDaysAgo: 120 }),
        // Finished, but young — the operator may still want to look at it.
        deadLetter('d-resolved-young', 'resolved', { resolvedDaysAgo: 89 }),
        // The morgue's live work. Never, whatever the age.
        deadLetter('d-pending-ancient', 'pending', { receivedDaysAgo: 400 }),
        deadLetter('d-failed-ancient', 'failed', { receivedDaysAgo: 400 }),
        // A pending row that somehow carries an old resolved_at (no code path
        // writes this — every resolver stamps status AND resolved_at together).
        // The STATUS, not the clock, is what makes a row finished — never.
        { ...deadLetter('d-pending-stale-clock', 'pending', { receivedDaysAgo: 300 }), resolved_at: daysAgo(300) },
        // A finished row with NO resolved_at (no code path writes this either).
        // The clock is resolved_at and only resolved_at: a row that never got
        // one is left alone rather than judged by received_at — the purge
        // never guesses at when a row finished.
        deadLetter('d-resolved-no-clock', 'resolved', { receivedDaysAgo: 300 }),
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { deleted: { webhook_dead_letter: 2, postmark_webhook_queue: 0 } } })
    expect(ids(db._state.deadLetters)).toEqual([
      'd-failed-ancient', 'd-pending-ancient', 'd-pending-stale-clock', 'd-resolved-no-clock', 'd-resolved-young',
    ])
    // Every delete carried the finished predicate — belt and braces on the id
    // list, so a row released between scan and delete could never go.
    const deletes = deletesFrom(db, 'webhook_dead_letter')
    expect(deletes.length).toBeGreaterThan(0)
    for (const d of deletes) {
      expect(d.filters).toContainEqual(['in', 'status', expect.arrayContaining(['resolved', 'discarded'])])
      expect(d.filters.find(f => f[0] === 'in' && f[1] === 'status')[2]).not.toContain('pending')
      expect(d.filters.find(f => f[0] === 'in' && f[1] === 'status')[2]).not.toContain('failed')
      expect(d.filters).toContainEqual(['lt', 'resolved_at', CUTOFF])
      expect(d.filters).toContainEqual(['in', 'id', expect.any(Array)])
    }
  })
})

describe('postmark_webhook_queue — what gets purged', () => {
  it('deletes only processed rows older than the cutoff; unprocessed, exhausted and stale-claim rows survive', async () => {
    setupDb({
      webhookQueue: [
        queueRow('q-processed-old', { processedDaysAgo: 200 }),
        queueRow('q-processed-young', { processedDaysAgo: 89 }),
        // Never processed, ancient — still the consumers' work (or a row the
        // sweeper has not reached). Never.
        queueRow('q-unprocessed-ancient', { receivedDaysAgo: 400 }),
        // Exhausted (POSTMARK-DLQ.1): processed_at NULL, attempts at the
        // budget, error prefixed. Its payload was captured to the dead letter,
        // whose row is purged on ITS resolution — this one is not "finished".
        queueRow('q-exhausted', {
          receivedDaysAgo: 400, attempts: MAX_ATTEMPTS, error: `${EXHAUSTED_ERROR_PREFIX}: boom`,
        }),
        // A stale claim (POSTMARK-QUEUE-RECLAIM.1): processed_at SET, marker
        // still in `error` — an unfinished event wearing a finished timestamp.
        // The reclaim sweep owns it; the purge must not destroy it.
        queueRow('q-stale-claim', { processedDaysAgo: 200, error: CLAIMED_ERROR_MARKER }),
        // Processed, and the LAST attempt's error text survived (the success
        // path clears the claim marker; an older release path may have left
        // its own message). Finished is finished — goes.
        queueRow('q-processed-with-old-error', { processedDaysAgo: 150, attempts: 2, error: 'transient: retried' }),
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deleted).toEqual({ webhook_dead_letter: 0, postmark_webhook_queue: 2 })
    expect(ids(db._state.webhookQueue)).toEqual([
      'q-exhausted', 'q-processed-young', 'q-stale-claim', 'q-unprocessed-ancient',
    ])
    const deletes = deletesFrom(db, 'postmark_webhook_queue')
    expect(deletes.length).toBeGreaterThan(0)
    for (const d of deletes) {
      expect(d.filters).toContainEqual(['not', 'processed_at', 'is', null])
      expect(d.filters).toContainEqual(['lt', 'processed_at', CUTOFF])
      // `error <> marker` alone would drop every NULL-error row (SQL's <> is
      // NULL for NULL), which is every cleanly processed row — the guard must
      // admit NULL explicitly.
      expect(d.filters).toContainEqual(['or', `error.is.null,error.neq.${CLAIMED_ERROR_MARKER}`])
      expect(d.filters).toContainEqual(['in', 'id', expect.any(Array)])
    }
  })
})

describe('paging', () => {
  it('pages through more than one select cap with .range() and an explicit .order()', async () => {
    const many = Array.from({ length: PURGE_PAGE_SIZE * 2 + 7 }, (_, i) =>
      deadLetter(`d-${String(i).padStart(5, '0')}`, i % 2 ? 'resolved' : 'discarded', { resolvedDaysAgo: 100 + (i % 50) }))
    const total = many.length
    setupDb({ deadLetters: many, webhookQueue: [queueRow('q-1', { processedDaysAgo: 120 })] })

    const orders = []
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      const origOrder = b.order
      b.order = (...a) => { orders.push({ table, column: a[0] }); return origOrder(...a) }
      return b
    }

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deleted.webhook_dead_letter).toBe(total)
    expect(db._state.deadLetters).toEqual([])
    // Delete-as-you-go: three pages at range(0, PAGE-1) — PAGE, PAGE, 7 —
    // plus the trailing short read is what ends the loop.
    const dlRanges = db.ranges.filter(r => r.table === 'webhook_dead_letter')
    expect(dlRanges.length).toBe(3)
    for (const r of dlRanges) expect([r.from, r.to]).toEqual([0, PURGE_PAGE_SIZE - 1])
    // Every candidate read ordered by the table's finished clock.
    expect(orders.filter(o => o.table === 'webhook_dead_letter').every(o => o.column === 'resolved_at')).toBe(true)
    expect(orders.filter(o => o.table === 'webhook_dead_letter').length).toBe(3)
    expect(orders.filter(o => o.table === 'postmark_webhook_queue').every(o => o.column === 'processed_at')).toBe(true)
    expect(body.data.pages.webhook_dead_letter).toBe(3)
  })

  it('does nothing and still stamps when there is nothing to purge', async () => {
    setupDb({
      deadLetters: [deadLetter('d-young', 'resolved', { resolvedDaysAgo: 3 })],
      webhookQueue: [queueRow('q-young', { processedDaysAgo: 3 })],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(db.deletes).toEqual([])
    expect(stampHeartbeat).toHaveBeenCalledWith('purge-webhook-payloads', expect.objectContaining({
      deleted: { webhook_dead_letter: 0, postmark_webhook_queue: 0 },
    }))
  })
})

describe('heartbeat and per-table failure', () => {
  it('stamps purge-webhook-payloads with the outcome when both tables succeed', async () => {
    setupDb({
      deadLetters: [deadLetter('d-old', 'resolved', { resolvedDaysAgo: 200 })],
      webhookQueue: [queueRow('q-old', { processedDaysAgo: 200 })],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('purge-webhook-payloads', expect.objectContaining({
      cutoff: CUTOFF,
      retention_days: RETENTION_DAYS,
      deleted: { webhook_dead_letter: 1, postmark_webhook_queue: 1 },
    }))
  })

  it('a failed dead-letter delete still purges the queue, answers 500 with the error, and does NOT stamp', async () => {
    setupDb({
      deadLetters: [deadLetter('d-old', 'resolved', { resolvedDaysAgo: 200 })],
      webhookQueue: [queueRow('q-old', { processedDaysAgo: 200 }), queueRow('q-young', { processedDaysAgo: 10 })],
      errors: { webhook_dead_letter: { code: '42703', message: 'column does not exist' } },
    })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/webhook_dead_letter/)
    expect(body.data.errors).toEqual({ webhook_dead_letter: 'column does not exist' })
    expect(body.data.deleted).toEqual({ webhook_dead_letter: 0, postmark_webhook_queue: 1 })
    expect(ids(db._state.webhookQueue)).toEqual(['q-young'])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed queue delete still purges the dead letters, answers 500, and does NOT stamp', async () => {
    setupDb({
      deadLetters: [deadLetter('d-old', 'resolved', { resolvedDaysAgo: 200 }), deadLetter('d-pending', 'pending')],
      webhookQueue: [queueRow('q-old', { processedDaysAgo: 200 })],
      errors: { postmark_webhook_queue: { code: '42501', message: 'permission denied' } },
    })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/postmark_webhook_queue/)
    expect(body.data.errors).toEqual({ postmark_webhook_queue: 'permission denied' })
    expect(body.data.deleted).toEqual({ webhook_dead_letter: 1, postmark_webhook_queue: 0 })
    expect(ids(db._state.deadLetters)).toEqual(['d-pending'])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
