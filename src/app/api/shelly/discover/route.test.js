// SHELLY-UI.4 — GET /api/shelly/discover.
//
// What this suite is actually protecting:
//
//  1. THE MASK. The holder lookup is cross-tenant by design, so the response
//     projection is the security boundary. Every foreign fixture row carries a
//     greppable name, location id and organisation id, and the assertions run
//     against JSON.stringify(body) — a route that spread a holder row instead
//     of building each field fails here rather than in production.
//
//  2. SAME-ORG IS THE ONLY CASE THAT GETS A NAME, and it needs a real org id on
//     BOTH sides. The undefined === undefined case is tested explicitly: that
//     is the comparison which, written naively, names every location on the
//     estate the moment an embed goes missing.
//
//  3. "NOT ADOPTED" IS NEVER GUESSED. A failed holder read is a 500, not a list
//     of green Adopt buttons for devices another tenant already holds.
//
//  4. THE KEY NEVER LEAVES. The connection fixture carries a real-looking
//     auth_key (loadConnectionWithKey returns the whole row on purpose), and no
//     response may contain it.
//
// normaliseAllStatus, loadConnectionWithKey and AUTH_ERROR are the REAL
// implementations — only createShellyClient is stubbed, since it is the one
// thing that would reach the network. @/lib/auth is mocked PARTIALLY
// (importOriginal) so the permission gate is the shipped one.

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

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import { logWarn } from '@/lib/log'
// Imported from reconcile.js ON PURPOSE, not from connections.js where it now
// lives: the re-export is what keeps the cron's importers working, so a test
// that reaches through it proves the two modules still agree on the copy.
import { AUTH_ERROR } from '@/lib/shelly/reconcile'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const LOC_C = 'c0000000-0000-0000-0000-000000000003'
const ORG_1 = '11111111-1111-4111-8111-111111111111'
const ORG_2 = '22222222-2222-4222-8222-222222222222'

const STORED_KEY = 'STOREDKEY_abcdef0123456789'
const HOST = 'shelly-68-eu.shelly.cloud'

const SIBLING_NAME = 'UN1T Hatch Street'
const FOREIGN_NAME = 'Rival Gym Ranelagh'

const locA = { id: LOC_A, organization_id: ORG_1, features: {} }
const OWNER_A = { id: 'u-owner', role: 'owner', profileRole: 'owner', rolesByLocation: { [LOC_A]: 'owner' }, activeLocation: locA }
const STAFF_A = { id: 'u-staff', role: 'staff', profileRole: 'staff', rolesByLocation: { [LOC_A]: 'staff' }, activeLocation: locA }
// An active location with NO organisation — the shape that makes
// `holderOrg === callerOrg` read undefined === undefined as "same org".
const OWNER_NO_ORG = { ...OWNER_A, activeLocation: { id: LOC_A, features: {} } }

// The row as the table holds it — SECRET INCLUDED, because
// loadConnectionWithKey deliberately returns the whole thing.
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

// ——— cloud fixtures (v1 /device/all_status) ————————————————————————————
const allStatus = (devicesStatus) => ({ ok: true, statusCode: 200, body: { data: { devices_status: devicesStatus } } })

const plug = ({ gen = 2, code = 'SNPL-00112EU', online = true, name = 'Front plug', channels = [0] } = {}) => {
  const entry = { _dev_info: { gen, code, online }, name }
  for (const c of channels) entry[`switch:${c}`] = { output: c === 0, apower: 12.5, aenergy: { total: 900 } }
  return entry
}
const gen1Plug = () => ({ _dev_info: { gen: 1, code: 'SHPLG-S', online: true }, relays: [{ ison: true }] })
const energyMeter = () => ({ _dev_info: { gen: 2, code: 'SPEM-003CEBEU', online: true }, 'em:0': { act_power: 12 } })

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

// PostgREST projects; so does this. Without it, "the response carries nothing
// but the allowlisted columns" would be an assertion about the fixture.
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

/**
 * Chainable double. `deviceRows` is ESTATE-WIDE and the terminal applies the
 * recorded filters, so a route that forgot `.in('device_id', …)` — or one that
 * added a location filter to a lookup that must not have one — sees a
 * different answer rather than the same convenient fixture.
 */
function makeDb(cfg = {}) {
  const conf = {
    connectionRow: connectionRow(),
    connectionError: null,
    deviceRows: [],
    deviceError: null,
    updateError: null,
    ...cfg,
  }
  const calls = { selects: [], updates: [] }

  const matches = (row, st) =>
    Object.entries(st.filters).every(([k, v]) => row[k] === v) &&
    Object.entries(st.ins).every(([k, v]) => (v || []).includes(row[k]))

  function rows(st) {
    let out = conf.deviceRows.filter((r) => matches(r, st))
    if (st.limit != null) out = out.slice(0, st.limit)
    return out.map((r) => project(r, st.cols))
  }

  function resolveRow(st, { strict }) {
    if (st.table === 'shelly_connections') {
      if (conf.connectionError) return { data: null, error: conf.connectionError }
      if (!conf.connectionRow && strict) return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
      return { data: conf.connectionRow ? project(conf.connectionRow, st.cols) : null, error: null }
    }
    const list = rows(st)
    if (!list.length && strict) return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }
    return { data: list[0] ?? null, error: null }
  }

  function resolveList(st) {
    if (st.table === 'shelly_connections') return { data: null, error: st.op === 'update' ? conf.updateError : null }
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
        maybeSingle: () => Promise.resolve(resolveRow(st, { strict: false })),
        single: () => Promise.resolve(resolveRow(st, { strict: true })),
        then: (ok, err) => Promise.resolve(resolveList(st)).then(ok, err),
      }
      return b
    },
  }
}

const req = () => new Request('http://localhost/api/shelly/discover')

let db
let allStatusMock
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}
function useCloud(result) {
  allStatusMock = vi.fn().mockResolvedValue(result)
  createShellyClient.mockReturnValue({ allStatus: allStatusMock })
}

beforeEach(() => {
  vi.clearAllMocks()
  useDb()
  useCloud(allStatus({ aabbcc112233: plug() }))
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('GET /api/shelly/discover — the connection', () => {
  it('409s not_connected when this location has no Shelly account, and calls no cloud', async () => {
    useDb({ connectionRow: null })
    const res = await GET(req())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('not_connected')
    expect(body.error).toBe('Connect your Shelly account first')
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('a FAILED connection read is a 500, never a "not connected" 409', async () => {
    useDb({ connectionError: { message: 'db down' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBeUndefined()
    expect(createShellyClient).not.toHaveBeenCalled()
  })

  it('reads the connection scoped to the session location and hands the key to the client', async () => {
    await GET(req())
    const read = db.calls.selects.find((s) => s.table === 'shelly_connections')
    expect(read.filters.location_id).toBe(LOC_A)
    expect(createShellyClient).toHaveBeenCalledWith(expect.objectContaining({ host: HOST, auth_key: STORED_KEY }))
  })

  it('403s a staff member before anything else happens', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await GET(req())).status).toBe(403)
    expect(createShellyClient).not.toHaveBeenCalled()
  })
})

describe('GET /api/shelly/discover — what the cloud says', () => {
  it('an auth failure parks the connection and answers key_rejected', async () => {
    useCloud({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await GET(req())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')

    expect(db.calls.updates).toHaveLength(1)
    const write = db.calls.updates[0]
    expect(write.table).toBe('shelly_connections')
    expect(write.filters.location_id).toBe(LOC_A)
    expect(write.payload.status).toBe('action_needed')
    // The cron's own wording, imported rather than re-typed: a staff-triggered
    // discovery and the next tick must not describe a dead key differently.
    expect(write.payload.last_error).toBe(AUTH_ERROR)
    expect(write.payload.last_error_at).toEqual(expect.any(String))
    expect(write.payload.updated_at).toEqual(expect.any(String))
  })

  it('still answers key_rejected when the status write itself failed', async () => {
    // A failed badge write costs a stale chip. Turning it into a 500 would
    // replace the one answer the operator can act on with one they cannot.
    useDb({ updateError: { message: 'db down' } })
    useCloud({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await GET(req())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')
  })

  it('a rate limit is a 429 — a retry-after, not a broken far end', async () => {
    useCloud({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await GET(req())
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
    expect(db.calls.updates).toEqual([])
  })

  it('any other failure is a 502 carrying the kind, and parks nothing', async () => {
    useCloud({ ok: false, kind: 'network', statusCode: 0 })
    const res = await GET(req())
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('network')
    expect(db.calls.updates).toEqual([])
  })
})

describe('GET /api/shelly/discover — the mask', () => {
  const adoptedHere = { device_id: 'aabbcc112233', channel: 0, location_id: LOC_A, locations: { name: 'UN1T Stillorgan', organization_id: ORG_1 } }
  const adoptedSibling = { device_id: 'aabbcc112233', channel: 0, location_id: LOC_B, locations: { name: SIBLING_NAME, organization_id: ORG_1 } }
  const adoptedForeign = { device_id: 'aabbcc112233', channel: 0, location_id: LOC_C, locations: { name: FOREIGN_NAME, organization_id: ORG_2 } }

  it('marks a device this location already holds as "here"', async () => {
    useDb({ deviceRows: [adoptedHere] })
    const body = await (await GET(req())).json()
    expect(body.success).toBe(true)
    // row_count, not count: these are channel ROWS. A four-relay Pro 4PM is
    // one device and four of them.
    expect(body.row_count).toBe(1)
    expect(body.devices[0]).toMatchObject({ device_id: 'aabbcc112233', channel: 0, adopted: 'here' })
    expect(body.devices[0].elsewhere_location_name).toBeUndefined()
  })

  it('names a SAME-ORG holder', async () => {
    useDb({ deviceRows: [adoptedSibling] })
    const body = await (await GET(req())).json()
    expect(body.devices[0].adopted).toBe('elsewhere')
    expect(body.devices[0].elsewhere_location_name).toBe(SIBLING_NAME)
  })

  it('flags an OTHER-ORG holder and names nobody', async () => {
    useDb({ deviceRows: [adoptedForeign] })
    const body = await (await GET(req())).json()
    expect(body.devices[0].adopted).toBe('elsewhere')
    expect(body.devices[0].elsewhere_location_name).toBeUndefined()

    const json = JSON.stringify(body)
    expect(json).not.toContain(FOREIGN_NAME)
    expect(json).not.toContain(LOC_C)
    expect(json).not.toContain(ORG_2)
    // Nothing else from the holder row travels either.
    expect(json).not.toContain('location_id')
    expect(json).not.toContain(STORED_KEY)
  })

  it('a caller with NO organisation gets no name — even for a holder with no organisation either', async () => {
    // undefined === undefined must not read as "same organisation".
    getCurrentUser.mockResolvedValue(OWNER_NO_ORG)
    useDb({
      deviceRows: [{ device_id: 'aabbcc112233', channel: 0, location_id: LOC_C, locations: { name: FOREIGN_NAME, organization_id: undefined } }],
    })
    const body = await (await GET(req())).json()
    expect(body.devices[0].adopted).toBe('elsewhere')
    expect(body.devices[0].elsewhere_location_name).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(FOREIGN_NAME)
  })

  it('a MISSING locations embed is treated as foreign, not as same-org', async () => {
    useDb({ deviceRows: [{ device_id: 'aabbcc112233', channel: 0, location_id: LOC_C, locations: null }] })
    const body = await (await GET(req())).json()
    expect(body.devices[0].adopted).toBe('elsewhere')
    expect(body.devices[0].elsewhere_location_name).toBeUndefined()
  })

  it('adopted is null for a device nobody holds', async () => {
    const body = await (await GET(req())).json()
    expect(body.devices[0].adopted).toBeNull()
  })

  it('masks PER CHANNEL — one adopted channel does not grey out its siblings', async () => {
    useCloud(allStatus({ aabbcc112233: plug({ channels: [0, 1] }) }))
    useDb({ deviceRows: [{ ...adoptedSibling, channel: 1 }] })
    const body = await (await GET(req())).json()
    expect(body.devices).toHaveLength(2)
    expect(body.devices.find((d) => d.channel === 0).adopted).toBeNull()
    expect(body.devices.find((d) => d.channel === 1).adopted).toBe('elsewhere')
  })

  it('a failed holder read is a 500 — "not adopted" is never guessed', async () => {
    useDb({ deviceError: { message: 'db down' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Could not check device ownership')
  })

  it('looks holders up by device id ONLY — estate-wide, bounded, never location-scoped', async () => {
    useDb({ deviceRows: [adoptedForeign] })
    await GET(req())
    const lookup = db.calls.selects.find((s) => s.table === 'shelly_devices')
    expect(lookup.ins.device_id).toEqual(['aabbcc112233'])
    // A location filter here would answer "free" for every foreign holder,
    // which is the answer that invites a doomed adopt.
    expect(lookup.filters.location_id).toBeUndefined()
    // One MORE than the cap, so a full page and a truncated one are
    // distinguishable (the findFingerprintRows pattern).
    expect(lookup.limit).toBe(501)
  })

  it('a TRUNCATED holder read warns and slices, it does not refuse', async () => {
    // Non-fatal here, unlike findFingerprintRows: a holder we missed can only
    // mislabel a chip as un-adopted, and the adopt route's own check is the
    // authoritative one — so the cost is a named 409 at adopt, never a
    // cross-tenant mistake. Refusing would block discovery outright.
    const ids = Array.from({ length: 501 }, (_, i) => `aabbcc${String(i).padStart(6, '0')}`)
    useDb({ deviceRows: ids.map((id) => ({ device_id: id, channel: 0, location_id: LOC_A, locations: { name: 'UN1T Stillorgan', organization_id: ORG_1 } })) })
    useCloud(allStatus(Object.fromEntries(ids.map((id) => [id, plug()]))))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('shelly-discover', expect.stringContaining('row cap'), expect.objectContaining({ locationId: LOC_A, cap: 500 }))
    // The 501st row is sliced off, so it reads as un-adopted rather than
    // carrying a half-read holder into the mask.
    const body = await res.json()
    expect(body.row_count).toBe(501)
    expect(body.devices.filter((d) => d.adopted === 'here')).toHaveLength(500)
  })

  it('skips the holder lookup entirely when the account has no devices', async () => {
    useCloud(allStatus({}))
    const body = await (await GET(req())).json()
    expect(body.devices).toEqual([])
    expect(body.row_count).toBe(0)
    expect(db.calls.selects.filter((s) => s.table === 'shelly_devices')).toEqual([])
  })
})

describe('GET /api/shelly/discover — the row shape', () => {
  it("carries the account's own name, model, gen and online flag", async () => {
    const body = await (await GET(req())).json()
    expect(body.devices[0]).toEqual({
      device_id: 'aabbcc112233',
      channel: 0,
      name: 'Front plug',
      model: 'SNPL-00112EU',
      gen: 2,
      online: true,
      supported: true,
      adopted: null,
    })
  })

  it('a Gen1 device is listed as unsupported WITH its reason, not hidden', async () => {
    useCloud(allStatus({ ddeeff445566: gen1Plug() }))
    const body = await (await GET(req())).json()
    expect(body.devices[0]).toMatchObject({ supported: false, reason: 'gen1', gen: 1 })
  })

  it('a device with components but no relay reads no_switch', async () => {
    useCloud(allStatus({ 998877665544: energyMeter() }))
    const body = await (await GET(req())).json()
    expect(body.devices[0]).toMatchObject({ supported: false, reason: 'no_switch' })
  })

  it('an offline plug that reported nothing is supported:null with no reason — "ask again later"', async () => {
    useCloud(allStatus({ aabbcc112233: { _dev_info: { gen: 2, code: 'SNPL-00112EU', online: false } } }))
    const body = await (await GET(req())).json()
    expect(body.devices[0].supported).toBeNull()
    expect(body.devices[0].online).toBe(false)
    expect(body.devices[0]).not.toHaveProperty('reason')
  })
})
