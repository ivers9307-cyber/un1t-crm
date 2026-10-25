// UN1TSYNC.7 — POST /api/locations/[id]/un1t-online/sync ("Sync now").
// Owner/master AT THE TARGET only (membership 404 first), runs runUn1tSync for
// that one location and returns its result. runUn1tSync is mocked: the engine
// is pinned in src/lib/un1t-online-sync.test.js, never a real network call.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/un1t-online-sync', () => ({ runUn1tSync: vi.fn() }))

import { POST, maxDuration } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runUn1tSync } from '@/lib/un1t-online-sync'
import { MANAGER_A_STAFF_B, STAFF_A_OWNER_B, OUTSIDER, MASTER, LOC_A, LOC_B } from '../../_role-gate-cases.js'

const params = (id) => ({ params: Promise.resolve({ id }) })
const req = () => new Request('http://x/api', { method: 'POST' })
const db = { marker: 'db' }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(db)
  runUn1tSync.mockResolvedValue({ ok: true, counts: { pulled: { clients: 5 } }, runId: 'run-1' })
  getCurrentUser.mockResolvedValue({
    id: 'u', role: 'owner', profileRole: 'owner', isMaster: false,
    locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' }, activeLocation: { id: LOC_A },
  })
})

describe('POST sync', () => {
  it('has a 120 s budget', () => {
    expect(maxDuration).toBe(120)
  })

  it('returns the runUn1tSync result for that location', async () => {
    const res = await POST(req(), params(LOC_A))
    expect(res.status).toBe(200)
    expect(runUn1tSync).toHaveBeenCalledWith(db, LOC_A)
    expect(await res.json()).toEqual({ success: true, data: { ok: true, counts: { pulled: { clients: 5 } }, runId: 'run-1' } })
  })

  it('reports a failed run as data with ok false and its reason (the run happened)', async () => {
    runUn1tSync.mockResolvedValue({ ok: false, reason: 'auth', counts: {}, runId: 'run-2' })
    const res = await POST(req(), params(LOC_A))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ ok: false, reason: 'auth' })
  })

  it('unauthenticated -> 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req(), params(LOC_A))).status).toBe(401)
    expect(runUn1tSync).not.toHaveBeenCalled()
  })

  it('a manager gets 403 and nothing runs', async () => {
    getCurrentUser.mockResolvedValue({ ...MANAGER_A_STAFF_B, rolesByLocation: { [LOC_A]: 'manager' }, locations: [{ id: LOC_A }] })
    expect((await POST(req(), params(LOC_A))).status).toBe(403)
    expect(runUn1tSync).not.toHaveBeenCalled()
  })

  it('a manager at A who is staff at B, asking for B -> 403', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    expect((await POST(req(), params(LOC_B))).status).toBe(403)
    expect(runUn1tSync).not.toHaveBeenCalled()
  })

  it('a stranger gets 404 and nothing runs', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await POST(req(), params(LOC_B))).status).toBe(404)
    expect(runUn1tSync).not.toHaveBeenCalled()
  })

  it('an owner at the target and a master may sync', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    expect((await POST(req(), params(LOC_B))).status).toBe(200)
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await POST(req(), params(LOC_A))).status).toBe(200)
    expect(runUn1tSync).toHaveBeenCalledTimes(2)
  })

  it('answers 500 when the engine throws, without leaking the message', async () => {
    runUn1tSync.mockRejectedValue(new Error('boom with un1t_secret'))
    const res = await POST(req(), params(LOC_A))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('un1t_secret')
  })
})
