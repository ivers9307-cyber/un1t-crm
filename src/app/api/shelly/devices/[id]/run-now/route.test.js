// SHELLY-UI.5 — run-now.
//
// The property under test is that the three "nothing happened" answers stay
// APART: switched off, no schedule, and already-correct are three different
// instructions to the operator, and runNowForDevice answers the first two with
// the same bare `noop` as the third. So the route decides them itself, before
// the engine and before the cloud — which is also why "disabled" must not
// spend a slot of the shared 1 req/sec account budget to be told no.

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
  return { ...actual, runNowForDevice: vi.fn() }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runNowForDevice } from '@/lib/shelly/reconcile'
import { AUTH_ERROR } from '@/lib/shelly/connections'
import {
  LOC_B, DEV_A, DEV_B, BAD_ID, OWNER_A, OWNER_NY, STAFF_A, STORED_KEY,
  deviceRow, connectionRow, makeDb, selectsFrom, req, ctxFor,
} from '../../../shelly-routes.test-helpers.js'

const runReq = () => req('http://localhost/api/shelly/devices/x/run-now')

const world = (over = {}, connections = null) => ({
  rows: {
    shelly_devices: [
      deviceRow(over),
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
  runNowForDevice.mockResolvedValue({ ok: true, action: 'on', reason: 'run_now' })
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('POST …/run-now — the refusals, in order', () => {
  it('404s a malformed id and a foreign id identically, running nothing', async () => {
    const malformed = await POST(runReq(), ctxFor(BAD_ID))
    const foreign = await POST(runReq(), ctxFor(DEV_B))
    expect(malformed.status).toBe(404)
    expect(foreign.status).toBe(404)
    expect(await malformed.json()).toEqual(await foreign.json())
    expect(runNowForDevice).not.toHaveBeenCalled()
  })

  it('409s a DISABLED device before it reads the connection or touches the cloud', async () => {
    useDb(world({ enabled: false }))
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('disabled')
    expect(body.error).toMatch(/switched off/i)
    expect(selectsFrom(db, 'shelly_connections')).toEqual([])
    expect(runNowForDevice).not.toHaveBeenCalled()
  })

  it('409s no_schedule — never conflated with disabled', async () => {
    useDb(world({ schedule_mode: 'none' }))
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('no_schedule')
    expect(body.error).not.toMatch(/switched off/i)
    expect(runNowForDevice).not.toHaveBeenCalled()
  })

  it('a device that is BOTH switched off and scheduleless answers no_schedule', async () => {
    // The order is the advice: "turn the schedule on" is useless when there is
    // no schedule to turn on.
    useDb(world({ enabled: false, schedule_mode: 'none' }))
    const body = await (await POST(runReq(), ctxFor(DEV_A))).json()
    expect(body.code).toBe('no_schedule')
  })

  it('409s not_connected', async () => {
    useDb(world({}, []))
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_connected')
    expect(runNowForDevice).not.toHaveBeenCalled()
  })

  it('500s a FAILED connection read rather than calling it not_connected', async () => {
    useDb({ ...world(), selectError: { shelly_connections: { message: 'db down' } } })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBeUndefined()
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(runReq(), ctxFor(DEV_A))).status).toBe(403)
    expect(runNowForDevice).not.toHaveBeenCalled()
  })
})

describe('POST …/run-now — what it applied', () => {
  it('reports the action and the reason', async () => {
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, applied: 'on', reason: 'run_now' })
  })

  // SHELLY-UI.9b — there is no "already correct" answer here, and the arm
  // that claimed one was unreachable. runNowForDevice plans with force:true,
  // and under force planDeviceAction's only null path is rule 2 (unmanaged),
  // which the two 409 guards above already took. A noop reaching this point
  // means the planner and this route disagree about what force means; a
  // cheerful applied:null would bury that under a green tick while no relay
  // moved, so it is a loud 500 instead.
  it('a noop from the planner is a loud 500, not a false applied:null', async () => {
    runNowForDevice.mockResolvedValue({ ok: true, noop: true })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'unexpected_noop' })
    expect(body.error).toMatch(/nothing was sent/i)
  })

  it('a real action still answers applied + reason', async () => {
    runNowForDevice.mockResolvedValue({ ok: true, action: 'on', reason: 'run_now' })
    expect(await (await POST(runReq(), ctxFor(DEV_A))).json())
      .toEqual({ success: true, applied: 'on', reason: 'run_now' })
  })

  it('hands the engine a connection carrying the LOCATION’s zone', async () => {
    getCurrentUser.mockResolvedValue(OWNER_NY)
    await POST(runReq(), ctxFor(DEV_A))
    const [, conn, device] = runNowForDevice.mock.calls[0]
    expect(conn.locations).toEqual({ timezone: 'America/New_York' })
    expect(device.id).toBe(DEV_A)
  })
})

describe('POST …/run-now — when it could not', () => {
  it('an auth failure parks the connection and answers key_rejected', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'auth' })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')
    const conn = db.rowsIn('shelly_connections')[0]
    expect(conn.status).toBe('action_needed')
    expect(conn.last_error).toBe(AUTH_ERROR)
  })

  it('a rate limit is a 429, not a 502 — the far end is not broken', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'rate_limited' })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
  })

  it('an unreadable timetable is a 502 that names the timetable', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'occurrences', error: 'db down' })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.code).toBe('occurrences')
    expect(body.error).toMatch(/timetable/i)
  })

  it('a row that cannot be commanded is a 500 about the ROW', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'bad_device' })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('bad_device')
  })

  it('anything else is a 502 carrying the kind, and never the key', async () => {
    runNowForDevice.mockResolvedValue({ ok: false, kind: 'network', statusCode: 0 })
    const res = await POST(runReq(), ctxFor(DEV_A))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'network', kind: 'network' })
    expect(JSON.stringify(body)).not.toContain(STORED_KEY)
  })
})
