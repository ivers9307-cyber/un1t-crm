// STALEWATCH.1 — an acknowledged stale job no longer holds the health check red;
// it is listed under `acknowledged`. A stale, unacknowledged job still 503s.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let checks
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from(table) {
      const q = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => (table === 'cron_health'
        ? { abortSignal: async () => ({ data: checks, error: null }) }
        : Promise.resolve({ data: [], error: null }))
      return q
    },
  }),
}))

const { GET } = await import('./route.js')
const call = () => GET(new Request('http://x', { headers: { authorization: 'Bearer s3cret' } }))

beforeEach(() => { process.env.CRON_SECRET = 's3cret' })

describe('GET /api/cron/health-check', () => {
  it('a stale, unacknowledged job is a 503', async () => {
    checks = [{ name: 'a', is_stale: true, is_acknowledged: false }, { name: 'b', is_stale: false }]
    const res = await call()
    expect(res.status).toBe(503)
    expect((await res.json()).stale).toEqual(['a'])
  })

  it('an acknowledged stale job is listed but does not hold it red', async () => {
    checks = [{ name: 'a', is_stale: true, is_acknowledged: true, acknowledged_until: '2026-11-20T00:00:00Z', acknowledged_note: 'token' }]
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stale).toEqual([])
    expect(body.acknowledged).toEqual([{ name: 'a', until: '2026-11-20T00:00:00Z', note: 'token' }])
  })

  it('a second job going stale turns it red even with the first acknowledged', async () => {
    checks = [{ name: 'a', is_stale: true, is_acknowledged: true }, { name: 'b', is_stale: true, is_acknowledged: false }]
    expect((await call()).status).toBe(503)
  })
})
