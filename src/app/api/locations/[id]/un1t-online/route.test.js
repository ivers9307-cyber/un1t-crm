// UN1TSYNC.7 — GET / PUT / DELETE /api/locations/[id]/un1t-online.
//
// The connect route for Hatch Street's un1t.online token. Pinned here:
//   - gate order is the membership-source route's: getCurrentUser (401) ->
//     assertLocationAccessOr404 (a stranger gets 404) -> guardMasterOrOwner AT
//     THE TARGET (a manager gets 403), on every method
//   - PUT stores the token/studio/expiry in the active channel_connections row
//     and NEVER echoes the token; a rejected token or a browser token (one with
//     allowed origins) is a 400 that writes nothing
//   - PUT warns `write_permissions` for a token that can change data
//   - PUT moves membership_source none -> un1t_online (audited, cache reset) and
//     leaves a studio already on glofox alone
//   - DELETE blanks the token and deactivates the row, never touching
//     membership_source
//
// @/lib/auth is the REAL module with only getCurrentUser mocked (Style B).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/membership/state-for-page', async () => {
  const actual = await vi.importActual('@/lib/membership/state-for-page')
  return { ...actual, resetMembershipStateCache: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/un1t-online', async () => {
  const actual = await vi.importActual('@/lib/un1t-online')
  return { ...actual, createUn1tClient: vi.fn() }
})

import { GET, PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'
import { resetMembershipStateCache } from '@/lib/membership/state-for-page'
import { createUn1tClient, Un1tAuthError, Un1tApiError } from '@/lib/un1t-online'
import { MANAGER_A_STAFF_B, STAFF_A_OWNER_B, OUTSIDER, MASTER, LOC_A, LOC_B } from '../_role-gate-cases.js'

const TOKEN = 'un1t_ABCDEFGHIJKLMNOPQRSTUVWX_secret-token-123'
const EXPIRES = '2027-01-15T00:00:00.000Z'

const READ_ONLY = ['clients:read', 'subscriptions:read', 'payments:read', 'events:read']
const FULL_PRESET = [...READ_ONLY, 'clients:update', 'events:create', 'bookings:delete']

function selfOf(overrides = {}) {
  return {
    id: 'tok-1',
    name: 'CRM sync',
    studio: { id: 'studio-9', title: 'UN1T Hatch Street', timezone: 'Europe/Dublin', currency: 'EUR' },
    permissions: READ_ONLY,
    allowed_origins: [],
    expires_at: EXPIRES,
    ...overrides,
  }
}

const ownerAt = (id) => ({
  id: 'u-owner', email: 'o@example.test', full_name: 'Owner', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id }], rolesByLocation: { [id]: 'owner' }, activeLocation: { id },
})

// A small in-memory supabase fake: select/eq/in/order/limit/maybeSingle/update/
// insert over plain arrays, thenable like the real builders. Anything the
// routes do that this does not model throws, so a stray query fails LOUD.
function makeDb(seed = {}) {
  const tables = {
    locations: [{ id: LOC_A, name: 'Hatch', membership_source: 'none' }],
    channel_connections: [],
    un1t_sync_runs: [],
    ...seed,
  }
  const writes = []
  let nextId = 1
  function builder(table) {
    const filters = []
    let mode = 'select'
    let payload = null
    let orderBy = null
    let max = Infinity
    const match = () => (tables[table] || []).filter((row) => filters.every(([op, col, val]) => (
      op === 'eq' ? row[col] === val : val.includes(row[col])
    )))
    const run = () => {
      if (!(table in tables)) throw new Error(`unexpected table ${table}`)
      if (mode === 'insert') {
        const row = { id: `row-${nextId++}`, ...payload }
        tables[table].push(row)
        writes.push({ table, op: 'insert', payload })
        return { data: [row], error: null }
      }
      if (mode === 'update') {
        const rows = match()
        for (const r of rows) Object.assign(r, payload)
        writes.push({ table, op: 'update', payload, filters: filters.map(([, c, v]) => [c, v]) })
        return { data: rows, error: null }
      }
      let rows = match()
      if (orderBy) rows = [...rows].sort((a, b) => (a[orderBy] < b[orderBy] ? 1 : -1))
      return { data: rows.slice(0, max), error: null }
    }
    const b = {
      select: () => b,
      eq: (c, v) => { filters.push(['eq', c, v]); return b },
      in: (c, v) => { filters.push(['in', c, v]); return b },
      order: (c) => { orderBy = c; return b },
      limit: (n) => { max = n; return b },
      update: (p) => { mode = 'update'; payload = p; return b },
      insert: (p) => { mode = 'insert'; payload = p; return b },
      maybeSingle: async () => { const r = run(); return { data: r.data[0] ?? null, error: r.error } },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { tables, writes, from: builder }
}

const params = (id) => ({ params: Promise.resolve({ id }) })
const putReq = (body) => new Request('http://x/api', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const plainReq = (method) => new Request('http://x/api', { method })

let db
let client
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  client = { getSelf: vi.fn(async () => selfOf()) }
  createUn1tClient.mockReturnValue(client)
  getCurrentUser.mockResolvedValue(ownerAt(LOC_A))
})

describe('PUT connect', () => {
  it('stores the token, studio and expiry and never echoes the token', async () => {
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(200)
    const text = await res.clone().text()
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('secret-token-123')
    expect(createUn1tClient).toHaveBeenCalledWith({ token: TOKEN })

    const row = db.tables.channel_connections[0]
    expect(row).toMatchObject({
      location_id: LOC_A,
      platform: 'un1t_online',
      is_active: true,
      access_token: TOKEN,
      external_account_id: 'studio-9',
      display_name: 'UN1T Hatch Street',
      token_expires_at: EXPIRES,
      status: 'connected',
      last_error: null,
      config: { token_id: 'tok-1', token_name: 'CRM sync', studio_title: 'UN1T Hatch Street', permissions: READ_ONLY },
    })
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({
      connected: true,
      studio_title: 'UN1T Hatch Street',
      token_name: 'CRM sync',
      permissions_count: 4,
      has_write_permissions: false,
      expires_at: EXPIRES,
    })
    expect(body.warning).toBeUndefined()
  })

  it('replaces the token on the existing active row rather than adding a second', async () => {
    db.tables.channel_connections.push({
      id: 'old', location_id: LOC_A, platform: 'un1t_online', is_active: true, access_token: 'un1t_old_old_old_old_old_old', status: 'action_needed', last_error: 'revoked',
    })
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(200)
    expect(db.tables.channel_connections).toHaveLength(1)
    expect(db.tables.channel_connections[0]).toMatchObject({ id: 'old', access_token: TOKEN, status: 'connected', last_error: null })
  })

  it('refuses a rejected token with 400 token_rejected and writes nothing', async () => {
    client.getSelf.mockRejectedValue(new Un1tAuthError('un1t.online refused the token (HTTP 401)', 401))
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('token_rejected')
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    expect(db.writes).toEqual([])
    expect(resetMembershipStateCache).not.toHaveBeenCalled()
  })

  it('answers 502 un1t_unreachable when un1t.online itself fails, and writes nothing', async () => {
    client.getSelf.mockRejectedValue(new Un1tApiError('un1t.online answered HTTP 503', { status: 503 }))
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('un1t_unreachable')
    expect(db.writes).toEqual([])
  })

  it('refuses a token with allowed origins (400 browser_token) and writes nothing', async () => {
    client.getSelf.mockResolvedValue(selfOf({ allowed_origins: ['https://hatch.example'] }))
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('browser_token')
    expect(db.writes).toEqual([])
  })

  it('refuses a malformed token with 400 before calling un1t.online', async () => {
    const res = await PUT(putReq({ token: 'not-a-token' }), params(LOC_A))
    expect(res.status).toBe(400)
    expect(createUn1tClient).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('warns write_permissions for the full-preset permission list', async () => {
    client.getSelf.mockResolvedValue(selfOf({ permissions: FULL_PRESET }))
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBe('write_permissions')
    expect(body.data.has_write_permissions).toBe(true)
    expect(body.data.permissions_count).toBe(FULL_PRESET.length)
  })

  it('flips membership_source from none to un1t_online (cache reset, audited)', async () => {
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(200)
    expect(db.tables.locations[0].membership_source).toBe('un1t_online')
    expect(resetMembershipStateCache).toHaveBeenCalledWith(LOC_A)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      action: 'location.membership_source_changed',
      details: { from: 'none', to: 'un1t_online', via: 'integrations/un1t-online' },
    })
  })

  it('leaves a studio already on glofox alone', async () => {
    db.tables.locations[0].membership_source = 'glofox'
    const res = await PUT(putReq({ token: TOKEN }), params(LOC_A))
    expect(res.status).toBe(200)
    expect(db.tables.locations[0].membership_source).toBe('glofox')
    expect(db.writes.filter((w) => w.table === 'locations')).toEqual([])
    expect(resetMembershipStateCache).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

describe('DELETE disconnect', () => {
  it('nulls the token and deactivates the row; membership_source is unchanged', async () => {
    db.tables.locations[0].membership_source = 'un1t_online'
    db.tables.channel_connections.push({
      id: 'c1', location_id: LOC_A, platform: 'un1t_online', is_active: true, access_token: TOKEN, status: 'connected',
    })
    const res = await DELETE(plainReq('DELETE'), params(LOC_A))
    expect(res.status).toBe(200)
    expect(db.tables.channel_connections[0]).toMatchObject({ is_active: false, access_token: null, status: 'not_connected' })
    expect(db.tables.locations[0].membership_source).toBe('un1t_online')
    expect(db.writes.filter((w) => w.table === 'locations')).toEqual([])
    expect(await res.text()).not.toContain(TOKEN)
  })

  it('is a harmless 200 when nothing is connected', async () => {
    const res = await DELETE(plainReq('DELETE'), params(LOC_A))
    expect(res.status).toBe(200)
  })
})

describe('GET status', () => {
  it('reports not connected with no row', async () => {
    const res = await GET(plainReq('GET'), params(LOC_A))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ connected: false, last_run: null })
  })

  it('returns the masked status and the last run summary, never the token', async () => {
    db.tables.channel_connections.push({
      id: 'c1', location_id: LOC_A, platform: 'un1t_online', is_active: true, access_token: TOKEN, status: 'action_needed',
      external_account_id: 'studio-9', display_name: 'UN1T Hatch Street', token_expires_at: EXPIRES,
      last_error: 'un1t.online refused the token', last_ok_at: '2026-10-01T10:00:00.000Z',
      config: { token_id: 'tok-1', token_name: 'CRM sync', studio_title: 'UN1T Hatch Street', permissions: FULL_PRESET },
    })
    db.tables.un1t_sync_runs.push(
      { id: 'r1', location_id: LOC_A, started_at: '2026-10-01T09:00:00.000Z', finished_at: '2026-10-01T09:01:00.000Z', duration_ms: 60000, status: 'ok', counts: {}, first_error: null },
      {
        id: 'r2', location_id: LOC_A, started_at: '2026-10-02T09:00:00.000Z', finished_at: '2026-10-02T09:00:05.000Z', duration_ms: 5000, status: 'error',
        counts: { pulled: { clients: 120 }, contacts: { created: 3 }, contact_errors: [{ un1t_user_id: 'x', reason: 'r' }], memberships: { ended: 1 } }, first_error: 'un1t.online refused the token',
      },
    )
    const res = await GET(plainReq('GET'), params(LOC_A))
    const text = await res.clone().text()
    expect(text).not.toContain(TOKEN)
    const { data } = await res.json()
    expect(data).toMatchObject({
      connected: true,
      status: 'action_needed',
      studio_title: 'UN1T Hatch Street',
      token_name: 'CRM sync',
      permissions_count: FULL_PRESET.length,
      has_write_permissions: true,
      expires_at: EXPIRES,
      last_error: 'un1t.online refused the token',
    })
    expect(data.last_run).toMatchObject({ status: 'error', started_at: '2026-10-02T09:00:00.000Z', first_error: 'un1t.online refused the token' })
    expect(data.last_run.counts).toEqual({ pulled: { clients: 120 }, contacts: { created: 3 }, memberships: { ended: 1 } })
  })
})

describe('role gate (every method)', () => {
  const calls = [
    ['GET', (id) => GET(plainReq('GET'), params(id))],
    ['PUT', (id) => PUT(putReq({ token: TOKEN }), params(id))],
    ['DELETE', (id) => DELETE(plainReq('DELETE'), params(id))],
  ]

  for (const [method, call] of calls) {
    it(`${method}: unauthenticated -> 401`, async () => {
      getCurrentUser.mockResolvedValue(null)
      expect((await call(LOC_A)).status).toBe(401)
    })

    it(`${method}: a manager at the target gets 403 and nothing is read or written`, async () => {
      getCurrentUser.mockResolvedValue({ ...MANAGER_A_STAFF_B, rolesByLocation: { [LOC_A]: 'manager' }, locations: [{ id: LOC_A }] })
      const res = await call(LOC_A)
      expect(res.status).toBe(403)
      expect(db.writes).toEqual([])
      expect(createUn1tClient).not.toHaveBeenCalled()
    })

    it(`${method}: a manager at A who is staff at B, asking for B -> 403`, async () => {
      getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
      expect((await call(LOC_B)).status).toBe(403)
    })

    it(`${method}: a stranger to the location gets 404`, async () => {
      getCurrentUser.mockResolvedValue(OUTSIDER)
      const res = await call(LOC_B)
      expect(res.status).toBe(404)
      expect(db.writes).toEqual([])
    })

    it(`${method}: an owner at the target (owner at B, A active) passes the gate`, async () => {
      getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
      db.tables.locations.push({ id: LOC_B, name: 'B', membership_source: 'none' })
      expect((await call(LOC_B)).status).toBe(200)
    })

    it(`${method}: a master passes the gate`, async () => {
      getCurrentUser.mockResolvedValue(MASTER)
      expect((await call(LOC_A)).status).toBe(200)
    })
  }
})
