// instagram-feed-sync — a dead token must be visible on the connection row.
//
// On 2026-09-26 Meta invalidated the Stillorgan Instagram token ("the session
// has been invalidated because the user changed their password…"). The cron
// kept running every 6h, got a 401 each time and correctly withheld its
// heartbeat, but the connection row still said status 'connected' with no
// last_error, so the Integrations hub showed Instagram healthy while the only
// signal was an anonymous stale-cron page. An auth-shaped Graph failure now
// flags the row; a transient one does not; the heartbeat rule is unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/instagram-feed', () => ({ syncLocationIgFeed: vi.fn() }))
vi.mock('@/lib/connection-health', async (importActual) => ({
  ...(await importActual()),
  stampConnectionError: vi.fn(async () => {}),
}))

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncLocationIgFeed } from '@/lib/instagram-feed'
import { stampConnectionError } from '@/lib/connection-health'

const CONN = { id: 'conn-1', location_id: 'loc-1', external_account_id: 'ig-1', access_token: 'tok' }

function fakeDb(rows) {
  const q = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  }
  return { from: vi.fn(() => q), q }
}

function graphFailure(status, graphError) {
  const e = new Error(`instagram-feed graph ${status}: ${graphError?.message || 'unknown'}`)
  e.status = status
  e.graphError = graphError
  return e
}

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/instagram-feed-sync', { headers: { authorization: `Bearer ${secret}` } })

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  db = fakeDb([CONN])
  createServerClient.mockImplementation(() => db)
})

describe('instagram-feed-sync', () => {
  it('selects the connection id (needed to flag the row)', async () => {
    syncLocationIgFeed.mockResolvedValue({ synced: 3 })
    await GET(req())
    expect(db.q.select.mock.calls[0][0]).toMatch(/\bid\b/)
  })

  it('stamps the heartbeat and flags nothing on a clean run', async () => {
    syncLocationIgFeed.mockResolvedValue({ synced: 3 })
    const res = await GET(req())
    expect((await res.json()).data).toEqual({ locations: 1, ok: 1, failed: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('instagram-feed-sync')
    expect(stampConnectionError).not.toHaveBeenCalled()
  })

  it('an invalidated token (401 / OAuthException 190) flags the connection and withholds the heartbeat', async () => {
    syncLocationIgFeed.mockRejectedValue(graphFailure(401, {
      message: 'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.',
      type: 'OAuthException', code: 190, error_subcode: 460,
    }))
    const res = await GET(req())
    expect((await res.json()).data).toEqual({ locations: 1, ok: 0, failed: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampConnectionError).toHaveBeenCalledTimes(1)
    const [dbArg, connId, message] = stampConnectionError.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(connId).toBe('conn-1')
    expect(message).toMatch(/reconnect/i)
    expect(message).toMatch(/session has been invalidated/)
  })

  it('a transient failure (5xx, network) does not flag the connection', async () => {
    syncLocationIgFeed.mockRejectedValueOnce(graphFailure(500, { message: 'An unexpected error has occurred', type: 'GraphMethodException', code: 1 }))
    await GET(req())
    syncLocationIgFeed.mockRejectedValueOnce(new Error('fetch failed'))
    await GET(req())
    expect(stampConnectionError).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s without the secret', async () => {
    expect((await GET(req('wrong'))).status).toBe(401)
    expect(syncLocationIgFeed).not.toHaveBeenCalled()
  })
})
