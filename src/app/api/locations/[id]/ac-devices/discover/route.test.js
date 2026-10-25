// ACDEVLOC.1 — vendor discovery for the location in the PATH, with a
// credential only ever in the request BODY. It replaces
// GET /api/studio-management/ac/pods?api_key=<key> (the live key in a URL on
// every Add Sensibo click) and …/lg-devices?pat=. @/lib/auth is REAL.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/connection-registry', () => ({ overlayConnections: vi.fn(async (_db, loc) => loc) }))
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual('@/lib/log')
  return { ...actual, logError: vi.fn() }
})
vi.mock('@/lib/sensibo', () => {
  class SensiboError extends Error { constructor(message, opts = {}) { super(message); this.status = opts.status } }
  return { listPods: vi.fn(), SensiboError }
})
vi.mock('@/lib/thinq', () => {
  class ThinqError extends Error { constructor(message, opts = {}) { super(message); this.status = opts.status } }
  return { listDevices: vi.fn(), ThinqError }
})

import * as route from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { listPods, SensiboError } from '@/lib/sensibo'
import { listDevices } from '@/lib/thinq'
import { LOC_B, MASTER, OUTSIDER, STAFF_A_OWNER_B } from '../../_role-gate-cases.js'

const STORED_B = { id: LOC_B, sensibo_api_key: 'sk-stored-b', thinq_pat: 'pat-stored-b', thinq_client_id: 'cid-b', thinq_country_code: 'IE' }

function fakeDb(creds = { data: STORED_B, error: null }) {
  const calls = []
  const from = (table) => {
    const call = { table, filters: [] }
    calls.push(call)
    const chain = { select: () => chain, eq: (c, v) => { call.filters.push([c, v]); return chain }, maybeSingle: () => Promise.resolve(creds) }
    return chain
  }
  return { calls, client: { from } }
}

const discover = (id, body) => route.POST(new Request(`http://localhost/api/locations/${id}/ac-devices/discover`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })

describe('POST …/ac-devices/discover (ACDEVLOC.1)', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = fakeDb()
    createServerClient.mockReturnValue(db.client)
    getCurrentUser.mockResolvedValue(MASTER) // A active
    listPods.mockResolvedValue([{ id: 'pod1', room_name: 'Floor', product_model: 'sky', on: true, raw: { internal: 'x' } }])
    listDevices.mockResolvedValue([{ device_id: 'lg1', alias: 'Bath M', model: 'm1', device_type: 'DEVICE_AIR_CONDITIONER', raw: { internal: 'y' } }])
  })

  it('has no GET: a credential never rides a query string', () => {
    expect(route.GET).toBeUndefined()
  })

  it('with no key typed, uses the key stored on B (the path), not the active studio', async () => {
    const res = await discover(LOC_B, { provider: 'sensibo' })
    expect(res.status).toBe(200)
    expect(db.calls[0].filters).toEqual([['id', LOC_B]])
    expect(listPods).toHaveBeenCalledWith('sk-stored-b')
  })

  it('a typed key (body) wins; the answer carries unit ids and names only', async () => {
    const res = await discover(LOC_B, { provider: 'sensibo', api_key: ' sk-typed-123 ' })
    expect(listPods).toHaveBeenCalledWith('sk-typed-123')
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ success: true, data: [{ id: 'pod1', room_name: 'Floor', product_model: 'sky' }] })
    expect(text).not.toContain('sk-typed-123')
    expect(text).not.toContain('sk-stored-b')
    expect(text).not.toContain('internal')
  })

  it('a vendor error is scrubbed of the key, and the log never sees it', async () => {
    listPods.mockRejectedValue(new SensiboError('Key sk-typed-123 is not valid', { status: 401 }))
    const res = await discover(LOC_B, { provider: 'sensibo', api_key: 'sk-typed-123' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Key •••• is not valid', code: 'sensibo_error' })
    expect(logError).toHaveBeenCalledWith('ac-devices', 'discovery failed', { locationId: LOC_B, code: 'sensibo_error', status: 401 })
    expect(JSON.stringify(logError.mock.calls)).not.toContain('sk-typed-123')
  })

  it('ThinQ uses B\'s stored PAT, client id and country; ids and names only', async () => {
    const res = await discover(LOC_B, { provider: 'thinq' })
    expect(listDevices).toHaveBeenCalledWith({ pat: 'pat-stored-b', clientId: 'cid-b', countryCode: 'IE' })
    expect(await res.json()).toEqual({ success: true, data: [{ device_id: 'lg1', alias: 'Bath M', model: 'm1' }] })
  })

  it('no key typed or saved → 400, vendor not called', async () => {
    db = fakeDb({ data: { ...STORED_B, sensibo_api_key: null }, error: null })
    createServerClient.mockReturnValue(db.client)
    const res = await discover(LOC_B, { provider: 'sensibo' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('sensibo_not_configured')
    expect(listPods).not.toHaveBeenCalled()
  })

  it('a failed credentials read → 500, vendor not called', async () => {
    db = fakeDb({ data: null, error: { message: 'boom' } })
    createServerClient.mockReturnValue(db.client)
    expect((await discover(LOC_B, { provider: 'sensibo' })).status).toBe(500)
    expect(listPods).not.toHaveBeenCalled()
  })

  it('an owner at B → 403 (discovery is master-only); an outsider → 404; nothing read', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    expect((await discover(LOC_B, { provider: 'sensibo' })).status).toBe(403)
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await discover(LOC_B, { provider: 'sensibo' })).status).toBe(404)
    expect(db.calls).toEqual([])
    expect(listPods).not.toHaveBeenCalled()
  })

  it('an unknown provider → 400', async () => {
    expect((await discover(LOC_B, { provider: 'daikin' })).status).toBe(400)
  })
})
