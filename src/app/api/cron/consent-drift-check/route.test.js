// CLASSPASS-CONSENT.2 — the drift check must report, and must NOT go green
// when it could not actually look. A check that stamps its heartbeat on a
// failed query is worse than no check: it reports health it never measured.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const stampHeartbeat = vi.fn()
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: (...a) => stampHeartbeat(...a) }))

const createServerClient = vi.fn()
vi.mock('@/lib/supabase', () => ({ createServerClient: () => createServerClient() }))

const { GET, findConsentDrift } = await import('./route.js')

const req = (auth) => ({ headers: { get: (k) => (k === 'authorization' ? auth : null) } })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'test-secret'
})
afterEach(() => {
  delete process.env.CRON_SECRET
})

describe('findConsentDrift', () => {
  it('returns the drifted rows', async () => {
    const rows = [{ contact_id: 'a', location_id: 'loc-1', email: 'a@x.com' }]
    const db = { rpc: vi.fn(async () => ({ data: rows, error: null })) }
    expect(await findConsentDrift(db)).toEqual({ rows, error: null })
    expect(db.rpc).toHaveBeenCalledWith('consent_drift_rows')
  })

  it('reports the error instead of throwing when the query fails', async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })) }
    expect(await findConsentDrift(db)).toEqual({ rows: [], error: 'boom' })
  })

  it('treats a null data payload as no drift', async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: null })) }
    expect(await findConsentDrift(db)).toEqual({ rows: [], error: null })
  })
})

describe('GET /api/cron/consent-drift-check', () => {
  it('401s without the CRON_SECRET bearer', async () => {
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset, rather than matching "Bearer undefined"', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req('Bearer undefined'))
    expect(res.status).toBe(401)
  })

  it('stamps the heartbeat and reports zero drift on a clean run', async () => {
    createServerClient.mockReturnValue({ rpc: async () => ({ data: [], error: null }) })
    const res = await GET(req('Bearer test-secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { drift: 0, contacts: [] } })
    expect(stampHeartbeat).toHaveBeenCalledWith('consent-drift-check')
  })

  it('reports the drifted contacts and still stamps the heartbeat', async () => {
    const rows = [
      { contact_id: 'a', location_id: 'loc-1', email: 'a@x.com' },
      { contact_id: 'b', location_id: 'loc-1', email: 'b@x.com' },
    ]
    createServerClient.mockReturnValue({ rpc: async () => ({ data: rows, error: null }) })
    const res = await GET(req('Bearer test-secret'))
    const body = await res.json()
    expect(body.data.drift).toBe(2)
    expect(body.data.contacts).toEqual(rows)
    expect(stampHeartbeat).toHaveBeenCalledWith('consent-drift-check')
  })

  it('does NOT stamp the heartbeat when the query failed', async () => {
    createServerClient.mockReturnValue({ rpc: async () => ({ data: null, error: { message: 'boom' } }) })
    const res = await GET(req('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
