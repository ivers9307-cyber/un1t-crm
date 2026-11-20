// ROUTEWRAP.C11 — the Postmark queue sweeper on defineCron: the wrapper owns
// the secret check (an unset secret is now a 401, was a 500), the error
// boundary and the stamp. Every run that read its batch stamps with the summary
// as last_outcome, as before; a failed batch read answers a fixed line and
// stamps nothing. Per-row outcomes come from the shared claim CAS, untouched.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/postmark-queue', async (importOriginal) => ({
  ...(await importOriginal()),
  claimAndProcessQueueRow: vi.fn(async () => ({ status: 'processed' })),
  reclaimStaleQueueClaims: vi.fn(async () => ({ reclaimed: 0, deadLettered: 0, failed: 0 })),
}))

import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { claimAndProcessQueueRow, reclaimStaleQueueClaims } from '@/lib/postmark-queue'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { GET } from './route.js'

const DB_TEXT = 'canceling statement due to statement timeout on db.internal'
const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/process-postmark-webhooks', { headers: auth ? { authorization: auth } : {} })
const event = (id, at) => ({ id, payload: { RecordType: 'Delivery' }, received_at: at, processed_at: null, error: null, attempts: 0 })

let db
function setup(rows = [], errors) {
  db = createFakeDb({ tables: { postmark_webhook_queue: rows }, errors })
  createServerClient.mockImplementation(() => db)
}
beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  setup()
})
afterEach(() => { vi.useRealTimers() })

describe('GET /api/cron/process-postmark-webhooks — defineCron', () => {
  it('refuses a caller without the secret, and every caller when the secret is unset: nothing read or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req('Bearer undefined'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    expect(db.calls).toEqual([])
    expect(reclaimStaleQueueClaims).not.toHaveBeenCalled()
    expect(claimAndProcessQueueRow).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an empty queue is a healthy run: stamps exactly its own row with the summary', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out).toMatchObject({ success: true, processed: 0, failed: 0, batch_size: 0 })
    expect(stampHeartbeat.mock.calls).toEqual([['process-postmark-webhooks', expect.objectContaining({ batch_size: 0, reclaimed: 0 })]])
  })

  it('counts each outcome, oldest first, and stamps; a failed or dead-lettered row is a count, not a failed run', async () => {
    setup([event(1, '2026-11-20T10:00:00Z'), event(2, '2026-11-20T10:01:00Z'), event(3, '2026-11-20T10:02:00Z'), event(4, '2026-11-20T10:03:00Z'), event(5, '2026-11-20T10:04:00Z')])
    claimAndProcessQueueRow
      .mockResolvedValueOnce({ status: 'processed' })
      .mockResolvedValueOnce({ status: 'skipped' })
      .mockResolvedValueOnce({ status: 'deferred' })
      .mockResolvedValueOnce({ status: 'failed', attempts: 2, error: DB_TEXT })
      .mockResolvedValueOnce({ status: 'failed', attempts: 5, deadLettered: true, error: DB_TEXT })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('statement timeout')
    expect(JSON.parse(text)).toMatchObject({ success: true, processed: 1, skipped: 1, deferred: 1, failed: 2, dead_lettered: 1, batch_size: 5 })
    expect(claimAndProcessQueueRow.mock.calls.map(([, row]) => row.id)).toEqual([1, 2, 3, 4, 5])
    expect(logError).toHaveBeenCalledWith('process-postmark-webhooks', expect.stringContaining('dead-lettered'), expect.objectContaining({ id: 5 }))
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls[0][1]).toMatchObject({ failed: 2, dead_lettered: 1 })
  })

  it('a failed batch read answers 500 with a fixed line, claims nothing, and stamps nothing', async () => {
    setup([event(1, '2026-11-20T10:00:00Z')], { postmark_webhook_queue: { select: { message: DB_TEXT } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the Postmark event queue' })
    expect(claimAndProcessQueueRow).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a spent time budget leaves the rest pending and still stamps (as before)', async () => {
    setup([event(1, '2026-11-20T10:00:00Z'), event(2, '2026-11-20T10:01:00Z')])
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-11-20T12:00:00Z'))
    claimAndProcessQueueRow.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.parse('2026-11-20T12:05:00Z'))
      return { status: 'processed' }
    })
    const out = await (await GET(req())).json()
    expect(out).toMatchObject({ success: true, processed: 1, time_budget_exhausted: true, unreached: 1 })
    expect(claimAndProcessQueueRow).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a throw answers the wrapper\'s fixed 500 and stamps nothing', async () => {
    setup([event(1, '2026-11-20T10:00:00Z')])
    claimAndProcessQueueRow.mockRejectedValueOnce(new Error(DB_TEXT))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('statement timeout')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
