// ROUTEWRAP.C7 — the dead-letter replay sweeper on defineCron: the wrapper owns
// the secret check, the error boundary and the stamp. The replay itself
// (claim CAS + re-drive) is src/lib/webhook-replay-queue.js, tested there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/webhook-replay-queue', () => ({ claimAndReplayDeadLetterRow: vi.fn(), REPLAYABLE_PROVIDERS: ['inbody', 'postmark'] }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')
const { claimAndReplayDeadLetterRow } = await import('@/lib/webhook-replay-queue')

const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/webhook-replay', { headers: authorization ? { authorization } : {} })
const NOW = Date.parse('2026-11-20T12:00:00Z')
const row = (id, over = {}) => ({
  id, provider: 'postmark', payload: {}, status: 'pending', attempts: 1, last_attempt_at: null,
  received_at: new Date(NOW - 3_600_000).toISOString(), ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
  h.clients = 0
  h.db = createFakeDb({
    tables: {
      webhook_dead_letter: [
        row('d1'),
        row('d2'),
        // Last tried 90s ago with attempts 1 → a 120s backoff: skipped.
        row('d3', { last_attempt_at: new Date(NOW - 90_000).toISOString() }),
        row('d4', { provider: 'glofox' }),
      ],
    },
  })
  claimAndReplayDeadLetterRow.mockResolvedValueOnce({ status: 'processed' }).mockResolvedValueOnce({ status: 'failed', error: 'boom' })
})

describe('GET /api/cron/webhook-replay', () => {
  it('refuses a caller without the cron secret: no client, nothing read, nothing stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(h.db.calls).toHaveLength(0)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unset secret is refused too', async () => {
    delete process.env.CRON_SECRET
    expect((await GET(req())).status).toBe(401)
    expect(h.clients).toBe(0)
  })

  it('a clean run replays eligible rows and stamps exactly its own row with the summary', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, ok: true, replayed: 1, failed: 1, skipped: 1 })
    expect(claimAndReplayDeadLetterRow.mock.calls.map(([, r]) => r.id)).toEqual(['d1', 'd2'])
    expect(stampHeartbeat.mock.calls).toEqual([['webhook-replay', { replayed: 1, failed: 1, skipped: 1 }]])
  })

  it('a failed candidate read: 500, fixed line, no database text, nothing replayed or stamped', async () => {
    h.db.errors.webhook_dead_letter = { select: { message: 'permission denied for table webhook_dead_letter' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, ok: false, error: 'Could not read the dead-letter queue' })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(claimAndReplayDeadLetterRow).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('webhook-replay', expect.any(String), expect.objectContaining({ err: expect.any(Object) }))
  })
})
