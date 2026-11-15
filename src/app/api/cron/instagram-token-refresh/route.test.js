// instagram-token-refresh — stamp only a run that actually refreshed (or had
// nothing to refresh), and say on the connection row when a token is dead.
//
// Audit 2026-11-15: the connections read discarded its error, so a failed
// read looped zero times, counted failed = 0 and stamped the heartbeat. A
// refusal from Meta was only ever a console line. Fictional ids only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/connection-health', async (importActual) => ({
  ...(await importActual()),
  stampConnectionError: vi.fn(async () => {}),
}))

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { stampConnectionError } from '@/lib/connection-health'

const CONN = { id: 'conn-1', location_id: 'loc-1', access_token: 'tok' }

function fakeDb({ rows = [CONN], readError = null, updateError = null } = {}) {
  const updates = []
  const read = {
    select: vi.fn(() => read),
    eq: vi.fn(() => read),
    then: (res, rej) => Promise.resolve({ data: readError ? null : rows, error: readError }).then(res, rej),
  }
  const write = (patch) => {
    updates.push(patch)
    const w = { eq: vi.fn(() => Promise.resolve({ error: updateError })) }
    return w
  }
  return { updates, from: vi.fn(() => ({ ...read, update: write })) }
}

const req = () => new Request('https://x.test/api/cron/instagram-token-refresh', { headers: { authorization: 'Bearer shh' } })
const graph = (status, body) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  db = fakeDb()
  createServerClient.mockImplementation(() => db)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('instagram-token-refresh', () => {
  it('refuses without the cron secret', async () => {
    const res = await GET(new Request('https://x.test/', { headers: { authorization: 'Bearer nope' } }))
    expect(res.status).toBe(401)
  })

  it('a failed connections read answers 500 and withholds the heartbeat', async () => {
    db = fakeDb({ readError: { code: '57014', message: 'statement timeout' } })
    vi.stubGlobal('fetch', graph(200, {}))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(fetch).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean refresh saves the new token and stamps', async () => {
    vi.stubGlobal('fetch', graph(200, { access_token: 'new-tok', token_type: 'bearer', expires_in: 5184000 }))
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ success: true, refreshed: 1, failed: 0 })
    expect(db.updates).toHaveLength(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('instagram-token-refresh', { refreshed: 1, failed: 0 })
  })

  it('no active connections is a clean run and stamps', async () => {
    db = fakeDb({ rows: [] })
    vi.stubGlobal('fetch', graph(200, {}))
    await GET(req())
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('a dead token (OAuthException 190) flags the connection and withholds the heartbeat', async () => {
    vi.stubGlobal('fetch', graph(400, { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } }))
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ refreshed: 0, failed: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampConnectionError).toHaveBeenCalledTimes(1)
    expect(stampConnectionError.mock.calls[0][1]).toBe('conn-1')
    expect(stampConnectionError.mock.calls[0][2]).toMatch(/reconnect/)
  })

  it('a transient refusal withholds the heartbeat but does not flag the row', async () => {
    vi.stubGlobal('fetch', graph(500, { error: { message: 'An unexpected error has occurred', code: 2, is_transient: true } }))
    await GET(req())
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(stampConnectionError).not.toHaveBeenCalled()
  })

  it('a refreshed token that fails to save counts as failed and withholds the heartbeat', async () => {
    db = fakeDb({ updateError: { code: '42501', message: 'permission denied' } })
    vi.stubGlobal('fetch', graph(200, { access_token: 'new-tok', token_type: 'bearer', expires_in: 5184000 }))
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ refreshed: 0, failed: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
