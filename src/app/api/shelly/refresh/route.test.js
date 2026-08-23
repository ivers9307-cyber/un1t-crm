// SHELLY-UI.5 — POST /api/shelly/refresh.
//
// It is the cron's OWN read step behind a button, so the suite's job is to
// prove the route does not quietly become a second implementation of it:
// refreshLocationState is called with this location's devices and a connection
// carrying this location's zone, and the counters it returns are passed
// through rather than re-derived.
//
// Plus the two things a button must not do: spend a slot of the shared
// 1 req/sec account budget when there is nothing adopted, and tell an operator
// to back off when they in fact got their refresh.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/shelly/reconcile', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, refreshLocationState: vi.fn() }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { refreshLocationState } from '@/lib/shelly/reconcile'
import { AUTH_ERROR } from '@/lib/shelly/connections'
import { MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, OWNER_A, OWNER_NY, STAFF_A, STORED_KEY,
  deviceRow, connectionRow, makeDb, selectsFrom, req,
} from '../shelly-routes.test-helpers.js'

const refreshReq = () => req('http://localhost/api/shelly/refresh')

const zero = (over = {}) => ({
  readings: new Map(), covered: new Set(), client: {}, nowIso: '2026-08-23T12:00:00.000Z',
  reads: 1, readFailures: 0, rateLimited: 0, stateWrites: 0,
  auth: false, config: false, anyOk: true, lastKind: null, stalled: false, budgetHit: false,
  ...over,
})

const world = (devices, connections = null) => ({
  rows: {
    shelly_devices: devices ?? [
      deviceRow(),
      deviceRow({ id: DEV_B, location_id: LOC_B, name: 'Their plug', device_id: 'ffeedd998877' }),
    ],
    shelly_connections: connections === null ? [connectionRow()] : connections,
  },
})

let db
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  useDb(world())
  refreshLocationState.mockResolvedValue(zero({ stateWrites: 2 }))
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('POST /api/shelly/refresh — before it reads anything', () => {
  it('409s not_connected without a cloud call', async () => {
    useDb(world(undefined, []))
    const res = await POST(refreshReq())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_connected')
    expect(refreshLocationState).not.toHaveBeenCalled()
  })

  it('500s a FAILED connection read — not "not connected"', async () => {
    useDb({ ...world(), selectError: { shelly_connections: { message: 'db down' } } })
    expect((await POST(refreshReq())).status).toBe(500)
    expect(refreshLocationState).not.toHaveBeenCalled()
  })

  it('answers a location with nothing adopted WITHOUT spending a budget slot', async () => {
    useDb(world([deviceRow({ id: DEV_B, location_id: LOC_B })]))
    const res = await POST(refreshReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, refreshed: 0, read_failures: 0 })
    expect(refreshLocationState).not.toHaveBeenCalled()
  })

  it('500s a failed device list', async () => {
    useDb({ ...world(), selectError: { shelly_devices: { message: 'db down' } } })
    expect((await POST(refreshReq())).status).toBe(500)
    expect(refreshLocationState).not.toHaveBeenCalled()
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(refreshReq())).status).toBe(403)
    expect(refreshLocationState).not.toHaveBeenCalled()
  })
})

describe('POST /api/shelly/refresh — what it hands the engine', () => {
  it('this location’s devices only, capped at what the cron reconciles', async () => {
    await POST(refreshReq())
    const list = selectsFrom(db, 'shelly_devices')[0]
    expect(list.filters).toEqual({ location_id: LOC_A })
    expect(list.limit).toBe(MAX_DEVICES_PER_LOCATION)
    expect(list.cols).not.toContain('*')

    const [, , devices] = refreshLocationState.mock.calls[0]
    expect(devices.map((d) => d.id)).toEqual([DEV_A])
  })

  it('a connection carrying the LOCATION’s zone', async () => {
    getCurrentUser.mockResolvedValue(OWNER_NY)
    await POST(refreshReq())
    const [, conn, , ctx] = refreshLocationState.mock.calls[0]
    expect(conn.locations).toEqual({ timezone: 'America/New_York' })
    // It builds its own client from this object, so the key has to be on it.
    expect(conn.auth_key).toBe(STORED_KEY)
    expect(typeof ctx.now).toBe('function')
  })
})

describe('POST /api/shelly/refresh — what it reports', () => {
  it('passes the counters through rather than re-deriving them', async () => {
    refreshLocationState.mockResolvedValue(zero({ stateWrites: 3, readFailures: 1, rateLimited: 2, lastKind: 'http' }))
    const body = await (await POST(refreshReq())).json()
    expect(body).toEqual({ success: true, refreshed: 3, read_failures: 1, rate_limited: 2, kind: 'http' })
  })

  it('an auth failure parks the connection and answers key_rejected', async () => {
    refreshLocationState.mockResolvedValue(zero({ auth: true, readFailures: 1, lastKind: 'auth' }))
    const res = await POST(refreshReq())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')
    const conn = db.rowsIn('shelly_connections')[0]
    expect(conn.status).toBe('action_needed')
    expect(conn.last_error).toBe(AUTH_ERROR)
  })

  it('429s only when the rate limit cost us EVERY reading', async () => {
    refreshLocationState.mockResolvedValue(zero({ rateLimited: 1, stateWrites: 0, readFailures: 1, lastKind: 'rate_limited' }))
    const res = await POST(refreshReq())
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
  })

  it('…and NOT when the refresh still landed', async () => {
    refreshLocationState.mockResolvedValue(zero({ rateLimited: 1, stateWrites: 2 }))
    const res = await POST(refreshReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ refreshed: 2, rate_limited: 1 })
  })

  it('a quiet studio is a 200 with nothing refreshed, not an error', async () => {
    // Every reading identical to what we already hold: the deadband swallowed
    // the lot, and that is a healthy answer.
    refreshLocationState.mockResolvedValue(zero({ stateWrites: 0 }))
    const res = await POST(refreshReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, refreshed: 0 })
  })

  it('never leaks the stored key', async () => {
    refreshLocationState.mockResolvedValue(zero({ readFailures: 1, lastKind: 'network' }))
    const body = await (await POST(refreshReq())).json()
    expect(JSON.stringify(body)).not.toContain(STORED_KEY)
  })
})
