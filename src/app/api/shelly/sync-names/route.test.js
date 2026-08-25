// SHELLY-NAMES.1 — POST /api/shelly/sync-names.
//
// What this suite is protecting:
//
//  1. THE TENANT BOUNDARY. The fake database is estate-wide (LOC_A's and
//     LOC_B's rows sit in one array), so a handler that dropped
//     `.eq('location_id', …)` on either the read OR the write renames the
//     studio next door and fails here.
//
//  2. THE SAFE DEFAULT. `overwrite:false` must never touch a name a human
//     typed on this surface — there is no undo, and nothing keeps the old one.
//
//  3. "WE DID NOT ASK" IS NOT "SHELLY HAS NO NAME". A device in a batch that
//     failed is neither renamed nor counted unresolved, and the diagnostic is
//     sampled from a device we actually read.
//
//  4. THE DIAGNOSTIC NEVER CARRIES A VALUE. The fixture plants a wifi password
//     and a device name in `settings`; neither may reach the log.
//
//  5. A LOST WRITE IS COUNTED, NOT SWALLOWED — including the zero-row UPDATE,
//     which PostgREST does not report as an error.
//
// resolveDeviceName, loadConnectionWithKey and the schema are the REAL
// implementations; only createShellyClient is stubbed, since it is the one
// thing that would reach the network.

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

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createShellyClient } from '@/lib/shelly/client'
import { logWarn } from '@/lib/log'
import { AUTH_ERROR } from '@/lib/shelly/connections'
import { MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'
import {
  LOC_A, LOC_B, DEV_A, DEV_B, OWNER_A, STAFF_A, STORED_KEY, SHELLY_ID,
  deviceRow, connectionRow, makeDb, selectsFrom, updatesTo, jsonReq,
} from '../shelly-routes.test-helpers.js'

const URL_ = 'http://localhost/api/shelly/sync-names'
const syncReq = (body = {}) => jsonReq(body, URL_)

const OTHER_ID = 'ffeedd998877'
const WIFI_SECRET = 'SECRET_WIFI_PASSWORD'

// A raw v2 `get` item, with the credentials a real `settings` carries — the
// diagnostic assertions are only meaningful against a payload that has
// something to leak.
const item = (id, over = {}) => ({
  id, code: 'S3SW-001X8EU', gen: 2, online: 1,
  status: { 'switch:0': { output: true } },
  settings: {
    wifi: { sta: { ssid: 'UN1T-GUEST', pass: WIFI_SECRET } },
    sys: { device: { name: 'Reception heater' } },
  },
  ...over,
})

// The account answers with a bare array; rawItemsOf also accepts the wrapped
// forms, and status.test.js pins that.
const okGet = (items) => ({ ok: true, statusCode: 200, body: items })

// SHELLY-NAMES.3 — the account layer's list. Default: it answers, and knows
// nobody. Every pre-existing expectation therefore holds unchanged, and a suite
// that wants the list to name something says so.
const okList = (devices) => ({ ok: true, statusCode: 200, body: { isok: true, data: { devices } } })

let db
let get
let deviceList
function useDb(cfg) {
  db = makeDb(cfg)
  createServerClient.mockReturnValue(db)
  return db
}

const world = (devices, connections = null) => ({
  rows: {
    shelly_devices: devices ?? [
      deviceRow({ name: null }),
      // The studio next door, with a name of its own and the same shape.
      deviceRow({ id: DEV_B, location_id: LOC_B, name: null, device_id: OTHER_ID }),
    ],
    shelly_connections: connections === null ? [connectionRow()] : connections,
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  useDb(world())
  get = vi.fn(async () => okGet([item(SHELLY_ID)]))
  deviceList = vi.fn(async () => okList([]))
  createShellyClient.mockReturnValue({ get, deviceList })
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('POST /api/shelly/sync-names — before it reads anything', () => {
  it('409s not_connected without a cloud call', async () => {
    useDb(world(undefined, []))
    const res = await POST(syncReq())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_connected')
    expect(get).not.toHaveBeenCalled()
  })

  it('500s a FAILED connection read — not "not connected"', async () => {
    useDb({ ...world(), selectError: { shelly_connections: { message: 'db down' } } })
    expect((await POST(syncReq())).status).toBe(500)
    expect(get).not.toHaveBeenCalled()
  })

  it('500s a failed device list', async () => {
    useDb({ ...world(), selectError: { shelly_devices: { message: 'db down' } } })
    expect((await POST(syncReq())).status).toBe(500)
    expect(get).not.toHaveBeenCalled()
  })

  it('answers a location with nothing adopted WITHOUT spending a budget slot', async () => {
    useDb(world([deviceRow({ id: DEV_B, location_id: LOC_B })]))
    const res = await POST(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, total: 0, updated: 0, unchanged: 0, unresolved: 0, write_failures: 0,
    })
    expect(get).not.toHaveBeenCalled()
  })

  it('403s a staff member', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await POST(syncReq())).status).toBe(403)
    expect(get).not.toHaveBeenCalled()
  })

  it('400s an unknown key rather than dropping it onto the safe default', async () => {
    const res = await POST(syncReq({ overwite: true }))
    expect(res.status).toBe(400)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('POST /api/shelly/sync-names — the tenant boundary', () => {
  it('reads and asks about THIS location only, capped at what the cron reconciles', async () => {
    await POST(syncReq())
    const list = selectsFrom(db, 'shelly_devices')[0]
    expect(list.filters).toEqual({ location_id: LOC_A })
    expect(list.limit).toBe(MAX_DEVICES_PER_LOCATION)
    expect(list.cols).not.toContain('*')
    // The other studio's device id never reaches the Shelly account.
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toEqual([SHELLY_ID])
    expect(get.mock.calls[0][1]).toEqual({ select: ['status', 'settings'] })
  })

  it('scopes the WRITE as well as the read, and leaves the neighbour untouched', async () => {
    await POST(syncReq())
    const write = updatesTo(db, 'shelly_devices')[0]
    expect(write.filters).toEqual({ id: DEV_A, location_id: LOC_A })
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_B).name).toBeNull()
  })

  it('never leaks the stored key', async () => {
    const body = await (await POST(syncReq())).json()
    expect(JSON.stringify(body)).not.toContain(STORED_KEY)
  })
})

describe('POST /api/shelly/sync-names — what it writes', () => {
  it('names an unnamed plug and reports it', async () => {
    const res = await POST(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, total: 1, updated: 1, unchanged: 0, unresolved: 0, write_failures: 0,
    })
    const row = db.rowsIn('shelly_devices').find((r) => r.id === DEV_A)
    expect(row.name).toBe('Reception heater')
    expect(row.updated_at).toEqual(expect.any(String))
  })

  it('LEAVES a name a human typed alone unless overwrite is asked for', async () => {
    useDb(world([deviceRow({ name: 'Sauna plug' })]))
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ updated: 0, unchanged: 1 })
    expect(db.rowsIn('shelly_devices')[0].name).toBe('Sauna plug')
    expect(updatesTo(db, 'shelly_devices')).toHaveLength(0)
  })

  it('…and replaces it when it is', async () => {
    useDb(world([deviceRow({ name: 'Sauna plug' })]))
    const res = await POST(syncReq({ overwrite: true }))
    expect(await res.json()).toMatchObject({ updated: 1, unchanged: 0 })
    expect(db.rowsIn('shelly_devices')[0].name).toBe('Reception heater')
  })

  it('does not write a row whose name already MATCHES, even under overwrite', async () => {
    useDb(world([deviceRow({ name: 'Reception heater' })]))
    const res = await POST(syncReq({ overwrite: true }))
    expect(await res.json()).toMatchObject({ updated: 0, unchanged: 1 })
    expect(updatesTo(db, 'shelly_devices')).toHaveLength(0)
  })

  it('names a multi-relay device PER CHANNEL, from one cloud read', async () => {
    useDb(world([
      deviceRow({ id: DEV_A, name: null, channel: 0 }),
      deviceRow({ id: DEV_B, location_id: LOC_A, name: null, channel: 1 }),
    ]))
    get.mockResolvedValue(okGet([item(SHELLY_ID, {
      status: { 'switch:0': {}, 'switch:1': {} },
      settings: { sys: { device: { name: 'Plant room' } }, 'switch:0': { name: 'Sauna' }, 'switch:1': { name: 'Ice bath' } },
    })]))
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ total: 2, updated: 2 })
    // One device, one slot of the shared budget — not one per adopted row.
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toEqual([SHELLY_ID])
    const names = db.rowsIn('shelly_devices').map((r) => r.name)
    expect(names).toEqual(['Sauna', 'Ice bath'])
  })

  it('batches at the client’s own MAX_GET_IDS rather than a hardcoded 10', async () => {
    const many = Array.from({ length: 12 }, (_, i) => deviceRow({
      id: `d0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      name: null,
      device_id: `aabbcc0000${String(i).padStart(2, '0')}`,
    }))
    useDb(world(many))
    get.mockImplementation(async (ids) => okGet(ids.map((id) => item(id))))
    await POST(syncReq())
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[0][0]).toHaveLength(10)
    expect(get.mock.calls[1][0]).toHaveLength(2)
    // ONE client for the whole route, so its 1 req/sec pacing spans both
    // batches — a client per batch is one that believes it has never called.
    expect(createShellyClient).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/shelly/sync-names — when Shelly has no name for a plug', () => {
  const nameless = (id) => ({ id, gen: 2, online: 1, status: { 'switch:0': {} }, settings: { wifi: { sta: { pass: WIFI_SECRET } } } })

  it('counts it unresolved, writes nothing, and logs the SHAPE once', async () => {
    get.mockResolvedValue(okGet([nameless(SHELLY_ID)]))
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ total: 1, updated: 0, unresolved: 1 })
    expect(updatesTo(db, 'shelly_devices')).toHaveLength(0)
    const warn = logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')
    expect(warn).toBeTruthy()
    expect(warn[2]).toMatchObject({ locationId: LOC_A, unresolved: 1 })
    expect(warn[2].shape).toMatchObject({ settingsKeys: ['wifi'], hasSysDeviceName: 'absent' })
  })

  it('the diagnostic carries KEYS ONLY — never the wifi password, never a name', async () => {
    // The whole reason this is a shape report and not a payload log.
    useDb(world([deviceRow({ name: null }), deviceRow({ id: DEV_B, location_id: LOC_A, name: null, device_id: OTHER_ID })]))
    get.mockResolvedValue(okGet([nameless(SHELLY_ID), item(OTHER_ID)]))
    await POST(syncReq())
    const warn = logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')
    const json = JSON.stringify(warn[2])
    expect(json).not.toContain(WIFI_SECRET)
    expect(json).not.toContain('Reception heater')
    expect(json).not.toContain('UN1T-GUEST')
  })

  it('says nothing at all when every plug resolved', async () => {
    await POST(syncReq())
    expect(logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')).toBeUndefined()
  })

  it('ONE line for a whole account, not one per device', async () => {
    useDb(world([deviceRow({ name: null }), deviceRow({ id: DEV_B, location_id: LOC_A, name: null, device_id: OTHER_ID })]))
    get.mockResolvedValue(okGet([nameless(SHELLY_ID), nameless(OTHER_ID)]))
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ unresolved: 2 })
    expect(logWarn.mock.calls.filter((c) => c[1] === 'no device name in the Shelly payload')).toHaveLength(1)
  })
})

describe('POST /api/shelly/sync-names — when the read fails', () => {
  it('an auth failure parks the connection and answers key_rejected', async () => {
    get.mockResolvedValue({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await POST(syncReq())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')
    const conn = db.rowsIn('shelly_connections')[0]
    expect(conn.status).toBe('action_needed')
    expect(conn.last_error).toBe(AUTH_ERROR)
    expect(updatesTo(db, 'shelly_devices')).toHaveLength(0)
  })

  it('a rate limit is a 429 — not a 502, and not a connection verdict', async () => {
    get.mockResolvedValue({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await POST(syncReq())
    expect(res.status).toBe(429)
    expect((await res.json()).code).toBe('rate_limited')
    expect(db.rowsIn('shelly_connections')[0].status).toBe('connected')
  })

  it('any OTHER failure writes the names it already resolved, THEN 502s partial', async () => {
    // Twelve devices, two batches: the first answers, the second does not. A
    // route that returned early would throw away ten completed renames because
    // of an unrelated blip on the batch after them.
    const many = Array.from({ length: 12 }, (_, i) => deviceRow({
      id: `d0000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      name: null,
      device_id: `aabbcc0000${String(i).padStart(2, '0')}`,
    }))
    useDb(world(many))
    get.mockImplementationOnce(async (ids) => okGet(ids.map((id) => item(id))))
    get.mockImplementationOnce(async () => ({ ok: false, kind: 'network', statusCode: 0 }))
    const res = await POST(syncReq())
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'network', partial: true, total: 12, updated: 10 })
    expect(db.rowsIn('shelly_devices').filter((r) => r.name === 'Reception heater')).toHaveLength(10)
    // "We did not ask" is NOT "Shelly has no name for it": the two unread
    // devices are neither renamed nor counted unresolved.
    expect(body.unresolved).toBe(0)
  })
})

describe('POST /api/shelly/sync-names — a lost write is counted, never swallowed', () => {
  it('a failed UPDATE is reported and does not stop the rest', async () => {
    // Fail the FIRST write only: one unwritable row must not cost the other
    // plugs their names.
    let writes = 0
    useDb({
      ...world([
        deviceRow({ name: null }),
        deviceRow({ id: DEV_B, location_id: LOC_A, name: null, device_id: OTHER_ID }),
      ]),
      updateError: { shelly_devices: () => (writes++ === 0 ? { message: 'write failed' } : null) },
    })
    get.mockResolvedValue(okGet([item(SHELLY_ID), item(OTHER_ID, { settings: { sys: { device: { name: 'Ice machine' } } } })]))
    const res = await POST(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 2, updated: 1, write_failures: 1 })
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_A).name).toBeNull()
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_B).name).toBe('Ice machine')
  })

  it('a zero-row UPDATE is a failure, not a success — PostgREST does not call it an error', async () => {
    // The device was removed between the read and the write. Counting it as
    // renamed would report a name that never landed, which is the whole reason
    // the route reads back `.select('id')` instead of trusting a null error.
    get.mockResolvedValue(okGet([item(SHELLY_ID)]))
    const original = db.from.bind(db)
    db.from = (table) => {
      const b = original(table)
      if (table !== 'shelly_devices') return b
      const update = b.update
      // A filter no row can satisfy — the shape of a row deleted mid-request.
      b.update = (payload) => { update(payload); b.eq('__deleted_meanwhile', true); return b }
      return b
    }
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ updated: 0, write_failures: 1 })
    expect(logWarn.mock.calls.some((c) => /touched no row/.test(c[1]))).toBe(true)
  })
})

// ——— SHELLY-NAMES.3 ————————————————————————————————————————————————
//
// The v2 payload proved LABEL-FREE at the live gate: six app-named Gen3 Minis
// with `sys.device.name` present-but-null and the cloud-grafted
// `DeviceInfo.name` null too. The Smart Control app labels the ACCOUNT record,
// which the official v2 API never returns — so a second, undocumented-but-live
// source is asked when, and only when, the device payload came back nameless.
//
// The rule this suite is really protecting: THE LIST IS AN ENHANCEMENT, NEVER A
// GATE. A sync that worked on v2 names alone must not start failing because the
// account layer hiccupped.

describe('POST /api/shelly/sync-names — the account layer', () => {
  const nameless = (id) => ({ id, gen: 2, online: 1, status: { 'switch:0': {} }, settings: { wifi: { sta: { pass: WIFI_SECRET } } } })

  it('names a plug the DEVICE payload had no label for', async () => {
    get.mockResolvedValue(okGet([nameless(SHELLY_ID)]))
    deviceList.mockResolvedValue(okList([{ id: SHELLY_ID.toUpperCase(), name: 'Reception heater' }]))
    const res = await POST(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 1, updated: 1, unresolved: 0 })
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_A).name).toBe('Reception heater')
    expect(deviceList).toHaveBeenCalledTimes(1)
  })

  it('reads the OBJECT-KEYED list shape too — the shape is undocumented', async () => {
    get.mockResolvedValue(okGet([nameless(SHELLY_ID)]))
    deviceList.mockResolvedValue(okList({ [SHELLY_ID]: { name: 'Ice bath' } }))
    await POST(syncReq())
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_A).name).toBe('Ice bath')
  })

  it('does NOT spend a slot of the shared budget when every plug already resolved', async () => {
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ updated: 1, unresolved: 0 })
    expect(deviceList).not.toHaveBeenCalled()
  })

  it('the DEVICE label still wins — the account list only fills gaps', async () => {
    // One named plug, one nameless: the list names both, and only the nameless
    // one takes its answer from there.
    useDb(world([deviceRow({ name: null }), deviceRow({ id: DEV_B, location_id: LOC_A, name: null, device_id: OTHER_ID })]))
    get.mockResolvedValue(okGet([item(SHELLY_ID), nameless(OTHER_ID)]))
    deviceList.mockResolvedValue(okList([
      { id: SHELLY_ID, name: 'Account label' },
      { id: OTHER_ID, name: 'Ice machine' },
    ]))
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ total: 2, updated: 2, unresolved: 0 })
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_A).name).toBe('Reception heater')
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_B).name).toBe('Ice machine')
  })

  it('a FAILED list is logged and the v2 names are written anyway — never a failed sync', async () => {
    // The whole point of the enhancement rule: main resolved this plug's name
    // from the device payload, and an unrelated blip on an undocumented
    // endpoint must not take it away.
    useDb(world([deviceRow({ name: null }), deviceRow({ id: DEV_B, location_id: LOC_A, name: null, device_id: OTHER_ID })]))
    get.mockResolvedValue(okGet([item(SHELLY_ID), nameless(OTHER_ID)]))
    deviceList.mockResolvedValue({ ok: false, kind: 'rate_limited', statusCode: 429 })
    const res = await POST(syncReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, total: 2, updated: 1, unresolved: 1 })
    expect(db.rowsIn('shelly_devices').find((r) => r.id === DEV_A).name).toBe('Reception heater')
    expect(logWarn.mock.calls.some((c) => /account name list failed/.test(c[1]))).toBe(true)
    // The connection is a bystander: only the read half's `auth` is evidence
    // about the credential.
    expect(db.rowsIn('shelly_connections')[0].status).toBe('connected')
  })

  it('an AUTH failure on the list parks the connection and answers key_rejected', async () => {
    get.mockResolvedValue(okGet([nameless(SHELLY_ID)]))
    deviceList.mockResolvedValue({ ok: false, kind: 'auth', statusCode: 401 })
    const res = await POST(syncReq())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_rejected')
    expect(db.rowsIn('shelly_connections')[0].last_error).toBe(AUTH_ERROR)
  })

  it('when NEITHER source has a name, the one warning carries BOTH shapes — keys only', async () => {
    get.mockResolvedValue(okGet([nameless(SHELLY_ID)]))
    deviceList.mockResolvedValue(okList([{ id: 'ffffffffffff', name: 'Somebody else', room: { name: 'Studio floor' } }]))
    const res = await POST(syncReq())
    expect(await res.json()).toMatchObject({ unresolved: 1, updated: 0 })
    const warn = logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')
    expect(warn[2].shape).toMatchObject({ settingsKeys: ['wifi'], hasSysDeviceName: 'absent' })
    expect(warn[2].listShape).toMatchObject({
      bodyKeys: ['data', 'isok'], dataKeys: ['devices'], devicesType: 'array', entryCount: 1, nameProp: 'string',
    })
    const json = JSON.stringify(warn[2])
    expect(json).not.toContain('Somebody else')
    expect(json).not.toContain('Studio floor')
    expect(json).not.toContain(WIFI_SECRET)
  })

  it('omits listShape entirely when the list never answered — never a faked shape', async () => {
    get.mockResolvedValue(okGet([nameless(SHELLY_ID)]))
    deviceList.mockResolvedValue({ ok: false, kind: 'network', statusCode: 0 })
    await POST(syncReq())
    const warn = logWarn.mock.calls.find((c) => c[1] === 'no device name in the Shelly payload')
    expect(warn[2]).not.toHaveProperty('listShape')
  })
})
