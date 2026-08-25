// SHELLY-UI.4 — GET/POST /api/shelly/devices.
//
// What this suite is actually protecting:
//
//  1. THE ADOPT ORDER. The device must be proved to be on the CALLER'S OWN
//     Shelly account before the cross-tenant holder query runs. The order is
//     asserted directly — a POST for an id the account does not know answers
//     404 AND the holder lookup is never issued — because the two error
//     messages, in the wrong order, are an existence oracle for other tenants'
//     hardware. A refactor that "tidies" the holder check upwards fails here.
//
//  2. THE LIST IS SCOPED. The fake holds BOTH tenants' device rows and filters
//     on the recorded .eq() calls, so a GET that dropped
//     .eq('location_id', …) returns the other studio's plugs and fails, rather
//     than passing against a conveniently single-tenant fixture.
//
//  3. THE COLUMN ALLOWLIST. The fake projects like PostgREST, so
//     "adopted_by never reaches a response" is an assertion about the route's
//     select list and not about the fixture being thin.
//
//  4. AN ADOPTED DEVICE IS INERT. enabled:false, schedule_mode:'none', the FULL
//     last_state shape, and last_seen_at null for a plug that never answered.
//
// normaliseGetItems, stateFromReading, loadConnectionWithKey,
// loadPublicConnection, ShellyAdoptBody and AUTH_ERROR are all REAL — only
// createShellyClient is stubbed, since it is the one thing that would reach the
// network.

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
vi.mock('@/lib/shelly/client', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, createShellyClient: vi.fn() }
})

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import { logWarn, logError } from '@/lib/log'
// Imported from reconcile.js ON PURPOSE, not from connections.js where it now
// lives: the re-export is what keeps the cron's importers working, so a test
// that reaches through it proves the two modules still agree on the copy.
import { AUTH_ERROR } from '@/lib/shelly/reconcile'
import { MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const LOC_C = 'c0000000-0000-0000-0000-000000000003'
const ORG_1 = '11111111-1111-4111-8111-111111111111'
const ORG_2 = '22222222-2222-4222-8222-222222222222'

const STORED_KEY = 'STOREDKEY_abcdef0123456789'
const HOST = 'shelly-68-eu.shelly.cloud'
const DEVICE_ID = 'aabbcc112233'

const SIBLING_NAME = 'UN1T Hatch Street'
const FOREIGN_NAME = 'Rival Gym Ranelagh'

const locA = { id: LOC_A, organization_id: ORG_1, features: {} }
const OWNER_A = { id: 'u-owner', role: 'owner', profileRole: 'owner', rolesByLocation: { [LOC_A]: 'owner' }, activeLocation: locA }
const MANAGER_A = { id: 'u-manager', role: 'manager', profileRole: 'manager', rolesByLocation: { [LOC_A]: 'manager' }, activeLocation: locA }
const STAFF_A = { id: 'u-staff', role: 'staff', profileRole: 'staff', rolesByLocation: { [LOC_A]: 'staff' }, activeLocation: locA }

const connectionRow = (over = {}) => ({
  id: 'conn-1',
  location_id: LOC_A,
  host: HOST,
  auth_key: STORED_KEY,
  auth_key_fingerprint: 'f'.repeat(64),
  key_hint: '6789',
  status: 'connected',
  last_ok_at: '2026-08-22T10:00:00.000Z',
  last_error: null,
  last_error_at: null,
  ...over,
})

// An adopted row as the table holds it — `adopted_by` included, so the
// allowlist assertion below is about the route's select list.
const deviceRow = (over = {}) => ({
  id: 'dev-1',
  location_id: LOC_A,
  device_id: DEVICE_ID,
  channel: 0,
  name: 'Front plug',
  model: 'SNPL-00112EU',
  gen: 2,
  zone: null,
  enabled: false,
  schedule_mode: 'none',
  fixed_windows: [],
  class_rule: {},
  override: null,
  last_applied: null,
  last_state: null,
  last_seen_at: null,
  adopted_by: 'u-someone',
  created_at: '2026-08-20T09:00:00.000Z',
  updated_at: '2026-08-20T09:00:00.000Z',
  locations: { name: 'UN1T Stillorgan', organization_id: ORG_1 },
  ...over,
})

// ——— cloud fixtures (v2 /devices/api/get) ——————————————————————————————
const getOk = (items) => ({ ok: true, statusCode: 200, body: items })

const cloudItem = ({
  id = DEVICE_ID, online = true, gen = 2, code = 'SNPL-00112EU',
  name = 'Cloud plug name', channels = [0], output = true,
} = {}) => {
  const status = {}
  for (const c of channels) {
    status[`switch:${c}`] = {
      output: c === 0 ? output : false,
      apower: 12.5,
      aenergy: { total: 900 },
      temperature: { tC: 31.5 },
      source: 'timer',
    }
  }
  return { id, online, gen, code, settings: { name }, status }
}

// The live-gate shape: a real device reading with NO label anywhere in it.
const labelless = (over = {}) => ({
  id: DEVICE_ID, online: true, gen: 2, code: 'SNPL-00112EU',
  status: { 'switch:0': { output: true } }, ...over,
})

// ——— fake supabase ————————————————————————————————————————————————————
function splitCols(cols) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of String(cols)) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

function project(row, cols) {
  if (!cols || cols === '*') return { ...row }
  const out = {}
  for (const col of splitCols(cols)) {
    const embed = col.match(/^([A-Za-z_]+)(?:!\w+)?\(/)
    const key = embed ? embed[1] : col
    out[key] = row[key] === undefined ? null : row[key]
  }
  return out
}

function makeDb(cfg = {}) {
  const conf = {
    connectionRow: connectionRow(),
    connectionError: null,
    // ESTATE-WIDE on purpose: the terminal applies the recorded filters, so an
    // unscoped list query sees LOC_B's rows and the test fails.
    deviceRows: [],
    deviceError: null,
    deviceCountError: null,
    nullCount: false, // a count PostgREST did not compute — null, not zero
    insertError: null,
    insertRow: undefined, // undefined => derive the returning row from the payload
    insertLenient: false, // true => a driver answering .single() with {data:null,error:null}
    ...cfg,
  }
  const calls = { selects: [], updates: [], inserts: [] }

  const matches = (row, st) =>
    Object.entries(st.filters).every(([k, v]) => row[k] === v) &&
    Object.entries(st.ins).every(([k, v]) => (v || []).includes(row[k]))

  function rows(st) {
    let out = conf.deviceRows.filter((r) => matches(r, st))
    if (st.limit != null) out = out.slice(0, st.limit)
    return out.map((r) => project(r, st.cols))
  }

  function insertResult(st, { strict }) {
    if (conf.insertError) return { data: null, error: conf.insertError }
    const base = conf.insertRow !== undefined
      ? conf.insertRow
      : { id: 'dev-new', created_at: '2026-08-23T12:00:00.000Z', updated_at: '2026-08-23T12:00:00.000Z', adopted_by: st.payload.adopted_by, ...st.payload }
    // PostgREST errors a zero-row .single(); `insertLenient` models the driver
    // that does not, which is the only world where the route's !row guard is
    // reachable — and the reason it exists.
    if (!base && strict && !conf.insertLenient) {
      return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
    }
    return { data: base ? project(base, st.cols) : null, error: null }
  }

  function resolveRow(st, { strict }) {
    if (st.op === 'insert') return insertResult(st, { strict })
    if (st.table === 'shelly_connections') {
      if (conf.connectionError) return { data: null, error: conf.connectionError }
      if (!conf.connectionRow && strict) return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
      return { data: conf.connectionRow ? project(conf.connectionRow, st.cols) : null, error: null }
    }
    if (conf.deviceError) return { data: null, error: conf.deviceError }
    const list = rows(st)
    if (!list.length && strict) return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
    return { data: list[0] ?? null, error: null }
  }

  function resolveList(st) {
    if (st.table === 'shelly_connections') return { data: null, error: null }
    if (st.selectOpts?.head) {
      if (conf.deviceCountError) return { data: null, count: null, error: conf.deviceCountError }
      if (conf.nullCount) return { data: null, count: null, error: null }
      return { data: null, count: conf.deviceRows.filter((r) => matches(r, st)).length, error: null }
    }
    if (conf.deviceError) return { data: null, count: null, error: conf.deviceError }
    const list = rows(st)
    return { data: list, count: list.length, error: null }
  }

  return {
    conf,
    calls,
    from(table) {
      const st = { table, op: 'select', cols: null, selectOpts: null, filters: {}, ins: {}, orders: [], limit: null, payload: null }
      const b = {
        select: (cols, opts) => { st.cols = cols; if (opts) st.selectOpts = opts; if (st.op === 'select') calls.selects.push(st); return b },
        eq: (col, val) => { st.filters[col] = val; return b },
        in: (col, vals) => { st.ins[col] = vals; return b },
        order: (col, opts) => { st.orders.push([col, opts]); return b },
        limit: (n) => { st.limit = n; return b },
        update: (payload) => { st.op = 'update'; st.payload = payload; calls.updates.push(st); return b },
        insert: (payload) => { st.op = 'insert'; st.payload = payload; calls.inserts.push(st); return b },
        maybeSingle: () => Promise.resolve(resolveRow(st, { strict: false })),
        single: () => Promise.resolve(resolveRow(st, { strict: true })),
        then: (ok, err) => Promise.resolve(resolveList(st)).then(ok, err),
      }
      return b
    },
  }
}

const getReq = () => new Request('http://localhost/api/shelly/devices')
const postReq = (body) => new Request('http://localhost/api/shelly/devices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// SHELLY-NAMES.3 — the account layer's list (`/interface/device/list`). The
// default answers and knows nobody, so every pre-existing expectation holds; a
// test that wants it to name something, or to fail, says so.
const listOk = (devices = []) => ({ ok: true, statusCode: 200, body: { isok: true, data: { devices } } })

let db
let getMock
let deviceListMock
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
function useCloud(result, listResult = listOk()) {
  getMock = vi.fn().mockResolvedValue(result)
  deviceListMock = vi.fn().mockResolvedValue(listResult)
  createShellyClient.mockReturnValue({ get: getMock, deviceList: deviceListMock })
}
/** Every shelly_devices select that pinned a device id — i.e. a holder query. */
const holderLookups = () => db.calls.selects.filter((s) => s.table === 'shelly_devices' && s.filters.device_id !== undefined)

beforeEach(() => {
  vi.clearAllMocks()
  useDb()
  useCloud(getOk([cloudItem()]))
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('GET /api/shelly/devices — the list', () => {
  it("returns only this location's rows, scoped by an explicit filter", async () => {
    useDb({ deviceRows: [deviceRow(), deviceRow({ id: 'dev-b', location_id: LOC_B, device_id: 'ffeedd998877', name: 'Their plug' })] })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.devices).toHaveLength(1)
    expect(body.devices[0].id).toBe('dev-1')
    expect(JSON.stringify(body)).not.toContain('Their plug')
    expect(JSON.stringify(body)).not.toContain(LOC_B)

    const list = db.calls.selects.find((s) => s.table === 'shelly_devices')
    expect(list.filters.location_id).toBe(LOC_A)
  })

  it('projects the column allowlist — adopted_by never reaches the page', async () => {
    useDb({ deviceRows: [deviceRow()] })
    const body = await (await GET(getReq())).json()
    expect(body.devices[0]).not.toHaveProperty('adopted_by')
    expect(body.devices[0]).toMatchObject({ device_id: DEVICE_ID, channel: 0, enabled: false, schedule_mode: 'none' })
    const list = db.calls.selects.find((s) => s.table === 'shelly_devices')
    expect(list.cols).not.toContain('*')
    expect(list.cols).not.toContain('adopted_by')
  })

  it('orders by name then created_at, and asks for one more row than the cap', async () => {
    await GET(getReq())
    const list = db.calls.selects.find((s) => s.table === 'shelly_devices')
    expect(list.orders.map(([c]) => c)).toEqual(['name', 'created_at'])
    expect(list.limit).toBe(MAX_DEVICES_PER_LOCATION + 1)
  })

  it('slices at the cap and warns — anything past it is adopted but never reconciled', async () => {
    const many = Array.from({ length: MAX_DEVICES_PER_LOCATION + 1 }, (_, i) =>
      deviceRow({ id: `dev-${i}`, device_id: `aabbcc1122${String(i).padStart(2, '0')}` }))
    useDb({ deviceRows: many })
    const body = await (await GET(getReq())).json()
    expect(body.devices).toHaveLength(MAX_DEVICES_PER_LOCATION)
    expect(logWarn).toHaveBeenCalledWith('shelly-devices', expect.stringContaining('cap exceeded'), expect.objectContaining({ locationId: LOC_A }))
  })

  it('a failed list read is a 500, not an empty studio', async () => {
    useDb({ deviceError: { message: 'db down' } })
    expect((await GET(getReq())).status).toBe(500)
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await GET(getReq())).status).toBe(403)
  })

  it('a MANAGER may list — device_control is theirs by role default', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await GET(getReq())).status).toBe(200)
  })
})

describe('GET /api/shelly/devices — the connection flags', () => {
  it('connected true, with the status string alongside it', async () => {
    useDb({ deviceRows: [deviceRow()] })
    const body = await (await GET(getReq())).json()
    expect(body.connected).toBe(true)
    expect(body.connection_status).toBe('connected')
    // The connection read is the public projection — never the key.
    expect(JSON.stringify(body)).not.toContain(STORED_KEY)
  })

  it('action_needed is NOT connected, and says so by name', async () => {
    useDb({ connectionRow: connectionRow({ status: 'action_needed', last_error: AUTH_ERROR }) })
    const body = await (await GET(getReq())).json()
    expect(body.connected).toBe(false)
    // The page distinguishes "re-paste your key" from "retrying" off this.
    expect(body.connection_status).toBe('action_needed')
  })

  it('an unconnected location lists its devices with a null status', async () => {
    useDb({ connectionRow: null, deviceRows: [deviceRow()] })
    const body = await (await GET(getReq())).json()
    expect(body.devices).toHaveLength(1)
    expect(body.connected).toBe(false)
    expect(body.connection_status).toBeNull()
  })

  it('a FAILED connection read keeps the list and says the status is UNKNOWN', async () => {
    // Three answers, not two. connected:false would tell a live studio its
    // plugs are unreachable and offer the Connect form; a 500 would throw away
    // a device list we read successfully. null/'unknown' is the only honest
    // one, and Task 6 renders it as "couldn't refresh" over the existing cards.
    useDb({ connectionError: { message: 'db down' }, deviceRows: [deviceRow()] })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.devices).toHaveLength(1)
    expect(body.connected).toBeNull()
    expect(body.connection_status).toBe('unknown')
    expect(logError).toHaveBeenCalledWith('shelly-devices', 'connection read failed', expect.objectContaining({ locationId: LOC_A }))
  })

  it("...and 'unknown' is never confused with a real status", async () => {
    // A location that genuinely has no connection still answers null, not
    // 'unknown' — the page must be able to tell "never connected" (show the
    // Connect form) from "we could not read it" (show the cards and retry).
    useDb({ connectionRow: null })
    expect((await (await GET(getReq())).json()).connection_status).toBeNull()
  })
})

describe('POST /api/shelly/devices — the order of the checks', () => {
  it('a device NOT on the account is a 404, and the holder lookup never runs', async () => {
    // The whole point: with the holder check first, a guessed MAC would answer
    // "already in use elsewhere" for another tenant's hardware.
    useDb({ deviceRows: [deviceRow({ id: 'dev-foreign', location_id: LOC_C, locations: { name: FOREIGN_NAME, organization_id: ORG_2 } })] })
    useCloud(getOk([]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_on_account')
    expect(body.error).toBe('Not found on this Shelly account')
    expect(holderLookups()).toEqual([])
    expect(db.calls.inserts).toEqual([])
    expect(JSON.stringify(body)).not.toContain(FOREIGN_NAME)
  })

  it('an item for a DIFFERENT id is not a match — .find(), never [0]', async () => {
    // A body that echoed some other device would otherwise be adopted under
    // the id the operator asked for: wrong model, wrong gen, wrong relay, and
    // a row whose device_id no switch answers to.
    useCloud(getOk([cloudItem({ id: 'ffeedd998877' })]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('not_on_account')
    expect(holderLookups()).toEqual([])
    expect(db.calls.inserts).toEqual([])
  })

  it('warns when the account answered but the normaliser recognised nothing', async () => {
    // Shape drift would otherwise present as a 404 on every adopt in the
    // estate, with copy blaming the operator for a device they can see in the
    // Shelly app.
    useCloud(getOk([{ unexpected: 'shape' }, { also: 'unexpected' }]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(404)
    expect(logWarn).toHaveBeenCalledWith(
      'shelly-devices',
      expect.stringContaining('could not read'),
      expect.objectContaining({ locationId: LOC_A, bodyType: 'array', entries: 2 }),
    )
  })

  it('does NOT warn about shape drift when the account is simply empty', async () => {
    useCloud(getOk([]))
    expect((await POST(postReq({ device_id: DEVICE_ID }))).status).toBe(404)
    expect(logWarn).not.toHaveBeenCalledWith('shelly-devices', expect.stringContaining('could not read'), expect.anything())
  })

  it('warns when the matched item carries an id and no device data at all', async () => {
    // The shape a per-id "not found" marker would take — it would void the
    // ownership gate, so it must never pass silently.
    useCloud(getOk([{ id: DEVICE_ID }]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(201)
    expect(logWarn).toHaveBeenCalledWith(
      'shelly-devices',
      expect.stringContaining('ownership gate may be void'),
      expect.objectContaining({ locationId: LOC_A }),
    )
  })

  it('does NOT warn for an ordinary offline plug — it has gen and model', async () => {
    useCloud(getOk([{ id: DEVICE_ID, online: false, gen: 2, code: 'SNPL-00112EU', status: {} }]))
    expect((await POST(postReq({ device_id: DEVICE_ID }))).status).toBe(201)
    expect(logWarn).not.toHaveBeenCalledWith('shelly-devices', expect.stringContaining('ownership gate'), expect.anything())
  })

  it('not_connected is answered before any cloud call', async () => {
    useDb({ connectionRow: null })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_connected')
    expect(createShellyClient).not.toHaveBeenCalled()
    expect(db.calls.inserts).toEqual([])
  })

  it('a failed connection read is a 500, not a not_connected', async () => {
    useDb({ connectionError: { message: 'db down' } })
    expect((await POST(postReq({ device_id: DEVICE_ID }))).status).toBe(500)
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('the cap is enforced BEFORE the cloud call', async () => {
    const many = Array.from({ length: MAX_DEVICES_PER_LOCATION }, (_, i) =>
      deviceRow({ id: `dev-${i}`, device_id: `aabbcc1122${String(i).padStart(2, '0')}` }))
    useDb({ deviceRows: many })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('device_cap')
    expect(body.error).toBe(`This location has reached the limit of ${MAX_DEVICES_PER_LOCATION} devices`)
    expect(createShellyClient).not.toHaveBeenCalled()
    expect(db.calls.inserts).toEqual([])
  })

  it('a failed COUNT refuses rather than adopting past the cap', async () => {
    // Past the cap a device is adopted, schedulable and never reconciled.
    useDb({ deviceCountError: { message: 'db down' } })
    expect((await POST(postReq({ device_id: DEVICE_ID }))).status).toBe(500)
    expect(db.calls.inserts).toEqual([])
  })

  it('a NULL count is refused too — it is not a zero', async () => {
    // PostgREST answers null for a count it did not compute; reading that as
    // "no devices here" waves through every adopt at a location on the cap.
    useDb({ nullCount: true })
    expect((await POST(postReq({ device_id: DEVICE_ID }))).status).toBe(500)
    expect(createShellyClient).not.toHaveBeenCalled()
    expect(db.calls.inserts).toEqual([])
  })

  it('asks the cloud for settings as well as status, with the lowercased id', async () => {
    await POST(postReq({ device_id: DEVICE_ID.toUpperCase() }))
    expect(getMock).toHaveBeenCalledWith([DEVICE_ID], { select: ['status', 'settings'] })
    expect(db.calls.inserts[0].payload.device_id).toBe(DEVICE_ID)
  })

  it('400s a device id that is not one', async () => {
    const res = await POST(postReq({ device_id: 'not-a-mac' }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues?.[0]?.message).toBe("That doesn't look like a Shelly device id")
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('403s a staff member before anything at all', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(postReq({ device_id: DEVICE_ID }))).status).toBe(403)
    expect(createShellyClient).not.toHaveBeenCalled()
    expect(db.calls.inserts).toEqual([])
  })
})

describe('POST /api/shelly/devices — what the cloud says', () => {
  it('an auth failure parks the connection and answers key_rejected', async () => {
    useCloud({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')

    const write = db.calls.updates[0]
    expect(write.table).toBe('shelly_connections')
    expect(write.filters.location_id).toBe(LOC_A)
    expect(write.payload).toMatchObject({ status: 'action_needed', last_error: AUTH_ERROR })
    expect(db.calls.inserts).toEqual([])
  })

  it('a rate limit is a 429', async () => {
    useCloud({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
  })

  it('any other failure is a 502 carrying the kind', async () => {
    useCloud({ ok: false, kind: 'network', statusCode: 0 })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('network')
    expect(db.calls.inserts).toEqual([])
  })
})

describe('POST /api/shelly/devices — what can be adopted', () => {
  it('refuses a Gen1 device with copy that names the reason', async () => {
    useCloud(getOk([{ id: DEVICE_ID, online: 1, gen: 1, code: 'SHPLG-S', status: { relays: [{ ison: true }] } }]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('unsupported')
    expect(body.reason).toBe('gen1')
    expect(body.error).toBe('Gen1 devices are not supported yet')
    expect(holderLookups()).toEqual([])
    expect(db.calls.inserts).toEqual([])
  })

  it('refuses a device with components but no relay', async () => {
    useCloud(getOk([{ id: DEVICE_ID, online: true, gen: 2, code: 'SPEM-003CEBEU', status: { 'em:0': { act_power: 12 } } }]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This device has no switch to control')
  })

  it('400s a channel the device does not have', async () => {
    useCloud(getOk([cloudItem({ channels: [0, 1] })]))
    const res = await POST(postReq({ device_id: DEVICE_ID, channel: 3 }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('bad_channel')
    expect(db.calls.inserts).toEqual([])
  })

  it('adopts a NON-ZERO channel the device does have', async () => {
    useCloud(getOk([cloudItem({ channels: [0, 1] })]))
    const res = await POST(postReq({ device_id: DEVICE_ID, channel: 1 }))
    expect(res.status).toBe(201)
    expect(db.calls.inserts[0].payload.channel).toBe(1)
  })

  it('an OFFLINE device that reported nothing adopts on channel 0 — supported:null is not a verdict', async () => {
    useCloud(getOk([{ id: DEVICE_ID, online: false, gen: 2, code: 'SNPL-00112EU', status: {} }]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(201)
  })

  it('...but not on a channel nobody has ever seen', async () => {
    useCloud(getOk([{ id: DEVICE_ID, online: false, gen: 2, code: 'SNPL-00112EU', status: {} }]))
    const res = await POST(postReq({ device_id: DEVICE_ID, channel: 2 }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('bad_channel')
    expect(db.calls.inserts).toEqual([])
  })
})

describe('POST /api/shelly/devices — who already holds it', () => {
  it('409s adopted_here when this location already has the channel', async () => {
    useDb({ deviceRows: [deviceRow()] })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('adopted_here')
    expect(body.error).toBe('Already adopted at this location')
    expect(db.calls.inserts).toEqual([])
  })

  it('names a SAME-ORG holder', async () => {
    useDb({ deviceRows: [deviceRow({ id: 'dev-sib', location_id: LOC_B, locations: { name: SIBLING_NAME, organization_id: ORG_1 } })] })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('adopted')
    expect(body.error).toBe(`Already in use at ${SIBLING_NAME}`)
  })

  it('refuses an OTHER-ORG holder generically, naming nobody', async () => {
    useDb({ deviceRows: [deviceRow({ id: 'dev-foreign', location_id: LOC_C, locations: { name: FOREIGN_NAME, organization_id: ORG_2 } })] })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('adopted')
    expect(body.error).toBe('This device is already in use elsewhere')
    const json = JSON.stringify(body)
    expect(json).not.toContain(FOREIGN_NAME)
    expect(json).not.toContain(LOC_C)
    expect(json).not.toContain(ORG_2)
  })

  it('a caller with NO organisation gets the generic refusal, not a name', async () => {
    // undefined === undefined must not read as "same organisation" — that is
    // the comparison which, written naively, names another business's studio.
    getCurrentUser.mockResolvedValue({ ...OWNER_A, activeLocation: { id: LOC_A, features: {} } })
    useDb({ deviceRows: [deviceRow({ id: 'dev-ghost', location_id: LOC_C, locations: { name: FOREIGN_NAME, organization_id: undefined } })] })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('This device is already in use elsewhere')
    expect(JSON.stringify(body)).not.toContain(FOREIGN_NAME)
  })

  it('a holder with a MISSING locations embed is foreign, not same-org', async () => {
    useDb({ deviceRows: [deviceRow({ id: 'dev-noembed', location_id: LOC_C, locations: null })] })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This device is already in use elsewhere')
  })

  it('a caller with an org and a holder with NONE is still foreign', async () => {
    useDb({ deviceRows: [deviceRow({ id: 'dev-ghost', location_id: LOC_C, locations: { name: FOREIGN_NAME, organization_id: null } })] })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).not.toContain(FOREIGN_NAME)
  })

  it('checks the holder per CHANNEL, not per device', async () => {
    useDb({ deviceRows: [deviceRow({ channel: 1, location_id: LOC_B, locations: { name: SIBLING_NAME, organization_id: ORG_1 } })] })
    useCloud(getOk([cloudItem({ channels: [0, 1] })]))
    const res = await POST(postReq({ device_id: DEVICE_ID, channel: 0 }))
    expect(res.status).toBe(201)
    const lookup = holderLookups()[0]
    expect(lookup.filters).toMatchObject({ device_id: DEVICE_ID, channel: 0 })
    expect(lookup.filters.location_id).toBeUndefined()
  })

  it('a failed holder read refuses — a missing row is not proof the channel is free', async () => {
    useDb({ deviceError: { message: 'db down' } })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not check whether this device is already in use')
    expect(db.calls.inserts).toEqual([])
  })
})

describe('POST /api/shelly/devices — the insert', () => {
  it('adopts INERT: disabled, no schedule, empty windows, with the full last_state', async () => {
    const res = await POST(postReq({ device_id: DEVICE_ID, name: 'Sauna' }))
    expect(res.status).toBe(201)

    const { payload } = db.calls.inserts[0]
    expect(payload).toMatchObject({
      location_id: LOC_A,
      device_id: DEVICE_ID,
      channel: 0,
      name: 'Sauna',
      model: 'SNPL-00112EU',
      gen: 2,
      enabled: false,
      schedule_mode: 'none',
      fixed_windows: [],
      class_rule: {},
      adopted_by: 'u-owner',
    })
    // The FULL seven-field shape (mig 562), with output taken from the reading.
    expect(payload.last_state).toEqual({
      online: true,
      output: true,
      apower: 12.5,
      aenergy_wh: 900,
      temperature_c: 31.5,
      source: 'timer',
      at: expect.any(String),
    })
    expect(payload.last_seen_at).toEqual(expect.any(String))
    expect(payload.last_seen_at).toBe(payload.last_state.at)
  })

  it("carries the reading's OFF state through rather than defaulting it on", async () => {
    useCloud(getOk([cloudItem({ output: false })]))
    await POST(postReq({ device_id: DEVICE_ID }))
    expect(db.calls.inserts[0].payload.last_state.output).toBe(false)
  })

  it('an offline device gets output:null and NO last_seen_at', async () => {
    useCloud(getOk([{ id: DEVICE_ID, online: false, gen: 2, code: 'SNPL-00112EU', status: {} }]))
    await POST(postReq({ device_id: DEVICE_ID }))
    const { payload } = db.calls.inserts[0]
    // null is "unknown", never "off" — and nothing has been SEEN, so the
    // health clock must not start green.
    expect(payload.last_state).toEqual({
      online: false, output: null, apower: null, aenergy_wh: null, temperature_c: null, source: null, at: expect.any(String),
    })
    expect(payload.last_seen_at).toBeNull()
  })

  it("falls back to the cloud account's own name, then to null", async () => {
    await POST(postReq({ device_id: DEVICE_ID }))
    expect(db.calls.inserts[0].payload.name).toBe('Cloud plug name')
    // The device payload had a label, so the account layer is never asked —
    // one adopt, one slot of the shared 1 req/sec budget.
    expect(deviceListMock).not.toHaveBeenCalled()

    useDb()
    useCloud(getOk([labelless()]))
    await POST(postReq({ device_id: DEVICE_ID }))
    expect(db.calls.inserts[0].payload.name).toBeNull()
  })

  // ——— SHELLY-NAMES.3 ————————————————————————————————————————————————
  // The v2 payload proved LABEL-FREE at the live gate — the Smart Control app
  // labels the ACCOUNT record, which the v2 API never returns.
  it('takes the name from the ACCOUNT layer when the device payload has none', async () => {
    useCloud(getOk([labelless()]), listOk([{ id: DEVICE_ID.toUpperCase(), name: 'Reception heater' }]))
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(201)
    expect(db.calls.inserts[0].payload.name).toBe('Reception heater')
    expect(deviceListMock).toHaveBeenCalledTimes(1)
    // ONE client for the whole handler, or the pacing between the two calls is
    // a client that believes it has never called.
    expect(createShellyClient).toHaveBeenCalledTimes(1)
  })

  it("the operator's own name still wins over both cloud sources", async () => {
    useCloud(getOk([labelless()]), listOk([{ id: DEVICE_ID, name: 'Account label' }]))
    await POST(postReq({ device_id: DEVICE_ID, name: 'Sauna' }))
    expect(db.calls.inserts[0].payload.name).toBe('Sauna')
  })

  it('a FAILED account list still adopts — nameless, with the shape warning', async () => {
    // A cosmetic gap must never cost the operator the device: the card renders
    // its placeholder and "Use Shelly names" fixes it later.
    useCloud(getOk([labelless()]), { ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(201)
    expect(db.calls.inserts[0].payload.name).toBeNull()
    expect(logWarn.mock.calls.some((c) => /account name list failed during adopt/.test(c[1]))).toBe(true)
    const warn = logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')
    // Nothing came back, so there is no list shape to report — never a faked one.
    expect(warn[2]).not.toHaveProperty('listShape')
  })

  it('an account list that named somebody ELSE logs BOTH shapes, keys only', async () => {
    useCloud(getOk([labelless()]), listOk([{ id: 'ffeedd998877', name: 'Their plug', room: { name: 'Studio floor' } }]))
    await POST(postReq({ device_id: DEVICE_ID }))
    expect(db.calls.inserts[0].payload.name).toBeNull()
    const warn = logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')
    expect(warn[2].shape).toBeTruthy()
    expect(warn[2].listShape).toMatchObject({ devicesType: 'array', entryCount: 1, nameProp: 'string' })
    const json = JSON.stringify(warn[2])
    expect(json).not.toContain('Their plug')
    expect(json).not.toContain('Studio floor')
  })

  it('returns the created row on the allowlist, with no adopted_by', async () => {
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.device.id).toBe('dev-new')
    expect(body.device).not.toHaveProperty('adopted_by')
    expect(db.calls.inserts[0].cols).not.toContain('*')
    expect(db.calls.inserts[0].cols).not.toContain('adopted_by')
  })

  it('maps the UNIQUE race (23505) to the generic 409, naming nobody', async () => {
    // Someone adopted this channel between the holder check and the insert.
    useDb({ insertError: { code: '23505', message: 'duplicate key value violates unique constraint "shelly_devices_device_channel_unique"' } })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('adopted')
    expect(body.error).toBe('This device is already in use elsewhere')
    expect(JSON.stringify(body)).not.toContain('unique constraint')
  })

  it('maps a CHECK violation (23514) to readable copy, never the pg message', async () => {
    useDb({ insertError: { code: '23514', message: 'new row violates check constraint "shelly_devices_device_id_check"' } })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Shelly rejected the device id or channel')
    expect(JSON.stringify(body)).not.toContain('check constraint')
  })

  it('any other write failure is a 500, not a success', async () => {
    useDb({ insertError: { code: '08006', message: 'connection failure' } })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  it('a returning row that never arrived is a 500, not a 201 with device:null', async () => {
    useDb({ insertRow: null, insertLenient: true })
    const res = await POST(postReq({ device_id: DEVICE_ID }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
