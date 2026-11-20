// ROUTEWRAP.C7 — the receipt-hunt sweeper on defineCron. The wrapper owns the
// secret check and this job's own liveness row; the WEEKLY row
// ('receipt-coverage-weekly') is stamped inside maybeFinalizeWeekly
// (src/lib/recon/finalize.js, tested there), never by this route.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/recon/hunt', () => ({ huntLine: vi.fn() }))
vi.mock('@/lib/recon/finalize', () => ({ maybeFinalizeWeekly: vi.fn(async () => ({ finalized: false, reason: 'queue_not_empty' })) }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')
const { huntLine } = await import('@/lib/recon/hunt')
const { maybeFinalizeWeekly } = await import('@/lib/recon/finalize')

const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/process-receipt-hunts', { headers: authorization ? { authorization } : {} })
const LINES = [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }]
const dbWith = (rows, errors = {}) => createFakeDb({ rpc: { claim_recon_hunt_batch: () => rows }, errors })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  h.clients = 0
  h.db = dbWith(LINES)
  huntLine.mockResolvedValueOnce({ outcome: 'found' }).mockResolvedValueOnce({ outcome: 'not_found' }).mockResolvedValueOnce({ outcome: 'error' })
})

describe('GET /api/cron/process-receipt-hunts', () => {
  it('refuses a caller without the cron secret: no client, nothing read, nothing stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(h.db.calls).toHaveLength(0)
    expect(huntLine).not.toHaveBeenCalled()
    expect(maybeFinalizeWeekly).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean tick hunts the claimed batch, asks the finalizer and stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { claimed: 3, found: 1, notFound: 1, failed: 1, finalized: false, finalizeReason: 'queue_not_empty' },
    })
    expect(h.db.calls).toEqual([{ rpc: 'claim_recon_hunt_batch', args: { p_limit: 3 } }])
    expect(maybeFinalizeWeekly).toHaveBeenCalledWith(h.db)
    expect(stampHeartbeat.mock.calls).toEqual([['process-receipt-hunts']])
  })

  it('an empty queue is still a clean tick: stamped', async () => {
    h.db = dbWith([])
    const body = await (await GET(req())).json()
    expect(body.data).toMatchObject({ claimed: 0, found: 0 })
    expect(stampHeartbeat.mock.calls).toEqual([['process-receipt-hunts']])
  })

  it('a failed batch claim: 500, fixed line, no database text, nothing hunted or stamped', async () => {
    h.db = dbWith(LINES, { rpc: { claim_recon_hunt_batch: { message: 'permission denied for function claim_recon_hunt_batch' } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not claim the hunt batch' })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(huntLine).not.toHaveBeenCalled()
    expect(maybeFinalizeWeekly).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('process-receipt-hunts', expect.any(String), expect.objectContaining({ err: expect.any(Object) }))
  })

  it('a finalizer that throws answers the wrapper fixed 500 and stamps nothing', async () => {
    maybeFinalizeWeekly.mockRejectedValueOnce(new Error('imap login failed for ops@example.com'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Cron run failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
