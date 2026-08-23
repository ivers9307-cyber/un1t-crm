import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runShellyReconcile,
  reconcileLocation,
  refreshLocationState,
  runNowForDevice,
  loadTodayOccurrences,
  MAX_CONNECTIONS,
  MAX_DEVICES,
  MAX_OCCURRENCES,
  READ_BATCH,
  ACTION_NEEDED_RETRY_MS,
  ERROR_RETRY_MS,
  ENERGY_LOOKBACK_DAYS,
  ENERGY_ROW_CAP,
  AUTH_ERROR,
  HOST_ERROR,
  RATE_LIMIT_ERROR,
} from './reconcile'
import { MIN_GAP_MS } from './client'
import { logWarn, logError } from '@/lib/log'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

beforeEach(() => { vi.clearAllMocks() })

// Monday 6 July 2026, 07:00 in Dublin (IST = UTC+1) — the first instant of the
// 07:00–21:30 window every fixture uses, so the planner answers `on`.
const NOW = Date.parse('2026-07-06T06:00:00Z')
// The SAME evening in New York: 23:30 on Monday the 6th. The UTC date has
// already rolled to the 7th and the location's day has not, which is the whole
// point — every day-keyed thing here must follow the LOCATION.
const NOW_NY = Date.parse('2026-07-07T03:30:00Z')

const iso = (ms) => new Date(ms).toISOString()
const HOUR = 3600_000

// ---------------------------------------------------------------- fixtures

const conn = (over = {}) => ({
  id: 'c1',
  location_id: 'loc-A',
  host: 'shelly-1-eu.shelly.cloud',
  auth_key: 'KEY-AAA',
  auth_key_fingerprint: 'a'.repeat(64),
  status: 'connected',
  last_error_at: null,
  created_at: '2026-01-01T00:00:00Z',
  locations: { timezone: 'Europe/Dublin' },
  ...over,
})

const dev = (over = {}) => ({
  id: 'd1',
  location_id: 'loc-A',
  device_id: 'aabbcc000001',
  channel: 0,
  name: 'Studio plug',
  enabled: true,
  schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5, 6, 7], on: '07:00', off: '21:30' }],
  class_rule: null,
  override: null,
  last_applied: null,
  last_state: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
})

// A v2 `get` item, in the shape normaliseGetItems reads.
const item = (id, chans = [{ channel: 0 }], online = true) => ({
  id,
  online: online ? 1 : 0,
  gen: 2,
  code: 'SNPL-00112EU',
  status: Object.fromEntries(chans.map((c) => [`switch:${c.channel}`, {
    output: c.output ?? true,
    apower: c.apower ?? 12.5,
    aenergy: { total: c.total ?? 1000 },
    temperature: { tC: c.tC ?? 21 },
    source: 'cloud',
  }])),
})

const okGet = (ids) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id)) })

// The last_state that okGet's default item produces, one minute ago — inside
// every deadband AND inside STATE_REFRESH_MS, so it must NOT be rewritten.
const settledState = (at = iso(NOW - 60_000)) => ({
  online: true, output: true, apower: 12.5, aenergy_wh: 1000, temperature_c: 21, source: 'cloud', at,
})

// ---------------------------------------------------------------- fake db

function makeDb(state = {}) {
  const { connections = [], devices = [], energy = [], occurrences = [], fail = {} } = state
  const writes = { deviceUpdates: [], connectionUpdates: [], energyUpserts: [] }
  const reads = { fromCalls: [], occurrenceBounds: null, occurrenceCalls: null, energyBounds: null, deviceLimits: [], connectionCalls: null, energyCalls: null }

  const chain = (op, args, run) => {
    const calls = [[op, args]]
    const self = { calls, then: (ok, err) => Promise.resolve().then(() => run(calls)).then(ok, err) }
    for (const m of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'order', 'limit']) {
      self[m] = (...a) => { calls.push([m, a]); return self }
    }
    return self
  }
  const arg = (calls, method, col) => calls.find((c) => c[0] === method && c[1][0] === col)?.[1]?.[1]
  const err = (m) => ({ data: null, error: { message: m } })

  const db = {
    writes,
    reads,
    from(table) {
      reads.fromCalls.push(table)
      if (table === 'shelly_connections') {
        return {
          select: (...a) => chain('select', a, (calls) => {
            reads.connectionCalls = calls
            return fail.connections ? err(fail.connections) : { data: connections, error: null }
          }),
          update: (patch) => chain('update', [patch], (calls) => {
            writes.connectionUpdates.push({ id: arg(calls, 'eq', 'id'), patch })
            return fail.connectionUpdate ? { error: { message: fail.connectionUpdate } } : { error: null }
          }),
        }
      }
      if (table === 'shelly_devices') {
        return {
          select: (...a) => chain('select', a, (calls) => {
            const loc = arg(calls, 'eq', 'location_id')
            reads.deviceLimits.push(calls.find((c) => c[0] === 'limit')?.[1]?.[0])
            if (fail.devicesThrow && (!fail.devicesThrowAt || fail.devicesThrowAt === loc)) throw new Error(fail.devicesThrow)
            if (fail.devices) return err(fail.devices)
            return { data: devices.filter((d) => d.location_id === loc), error: null }
          }),
          update: (patch) => chain('update', [patch], (calls) => {
            writes.deviceUpdates.push({ id: arg(calls, 'eq', 'id'), patch })
            return fail.deviceUpdate ? { error: { message: fail.deviceUpdate } } : { error: null }
          }),
        }
      }
      if (table === 'shelly_energy_daily') {
        return {
          select: (...a) => chain('select', a, (calls) => {
            const loc = arg(calls, 'eq', 'location_id')
            reads.energyBounds = [arg(calls, 'gte', 'day'), arg(calls, 'lte', 'day')]
            reads.energyCalls = calls
            if (fail.energy) return err(fail.energy)
            const ids = arg(calls, 'in', 'device_id') || []
            // Newest first, mirroring the .order() the reconcile now asks for —
            // so a test that relies on the ordering is testing the real shape.
            return {
              data: energy
                .filter((r) => r.location_id === loc && ids.includes(r.device_id))
                .sort((a, b) => String(b.day).localeCompare(String(a.day))),
              error: null,
            }
          }),
          upsert: (rows, opts) => chain('upsert', [rows, opts], () => {
            writes.energyUpserts.push({ rows, opts })
            return fail.energyUpsert ? { error: { message: fail.energyUpsert } } : { error: null }
          }),
        }
      }
      if (table === 'class_occurrences') {
        return {
          select: (...a) => chain('select', a, (calls) => {
            reads.occurrenceBounds = [arg(calls, 'gte', 'starts_at'), arg(calls, 'lt', 'starts_at')]
            reads.occurrenceCalls = calls
            if (fail.occurrences) return err(fail.occurrences)
            return { data: occurrences, error: null }
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const callArgs = (calls, method) => calls.find((c) => c[0] === method)?.[1]
const stateWritesOf = (db) => db.writes.deviceUpdates.filter((w) => 'last_state' in w.patch)
const stampsOf = (db) => db.writes.deviceUpdates.filter((w) => 'last_applied' in w.patch)

// ---------------------------------------------------------------- fake client

function makeClientFactory(script = {}) {
  const calls = { get: [], setGroups: [], setSwitch: [] }
  let inFlight = 0
  let maxInFlight = 0
  const gate = async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 0))
    inFlight--
  }
  const factory = vi.fn((c) => {
    const loc = c?.location_id
    return {
      get: vi.fn(async (ids) => {
        calls.get.push({ loc, ids: [...ids] })
        await gate()
        return script.get ? script.get({ ids, loc, n: calls.get.length }) : okGet(ids)
      }),
      setGroups: vi.fn(async (gids, on) => {
        calls.setGroups.push({ loc, gids: [...gids], on })
        await gate()
        return script.setGroups ? script.setGroups({ gids, on, loc }) : { ok: true, statusCode: 200, failed: {} }
      }),
      setSwitch: vi.fn(async (id, ch, on) => {
        calls.setSwitch.push({ loc, id, ch, on })
        await gate()
        return script.setSwitch ? script.setSwitch({ id, ch, on }) : { ok: true, statusCode: 200, body: {} }
      }),
    }
  })
  return { factory, calls, peak: () => maxInFlight }
}

const deps = (over = {}) => ({
  now: () => NOW,
  sleep: async () => {},
  loadOccurrences: async () => ({ ok: true, occurrences: [] }),
  ...over,
})

const warned = (fragment) => logWarn.mock.calls.filter((c) => String(c[1]).includes(fragment))

// ================================================================== sweep

describe('runShellyReconcile — the sweep', () => {
  it('is dormant with no connections: no client, no warning', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ connections: [] })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(out).toEqual({ ok: true, locations: 0 })
    expect(factory).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('reports a connection load failure rather than looking dormant', async () => {
    const db = makeDb({ fail: { connections: 'pg down' } })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(out).toEqual({ ok: false })
    expect(warned('connection load failed')).toHaveLength(1)
  })

  it('parks an action_needed connection whose error is inside the retry window', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({
      connections: [conn({ status: 'action_needed', last_error_at: iso(NOW - 60_000) })],
      devices: [dev()],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(out).toMatchObject({ ok: true, locations: 0, parked: 1 })
    expect(factory).not.toHaveBeenCalled()
    expect(db.reads.fromCalls).toEqual(['shelly_connections'])
  })

  it('retries an action_needed connection once the retry window has passed', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({
      connections: [conn({ status: 'action_needed', last_error_at: iso(NOW - ACTION_NEEDED_RETRY_MS - 1000) })],
      devices: [dev()],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(out).toMatchObject({ locations: 1, parked: 0 })
    expect(calls.get).toHaveLength(1)
  })

  // A row that cannot say when it broke must be retried, never stranded.
  it('does not park an action_needed connection with an unreadable last_error_at', async () => {
    const { calls, factory } = makeClientFactory()
    const db = makeDb({ connections: [conn({ status: 'action_needed', last_error_at: null })], devices: [dev()] })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(out).toMatchObject({ locations: 1, parked: 0 })
    expect(calls.get).toHaveLength(1)
  })

  it('warns and slices when the connection cap is exceeded', async () => {
    const connections = Array.from({ length: MAX_CONNECTIONS + 1 }, (_, i) =>
      conn({ id: `c${i}`, location_id: `loc-${i}`, auth_key_fingerprint: `f${i}` }))
    const db = makeDb({ connections, devices: [] })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(out.locations).toBe(MAX_CONNECTIONS)
    expect(warned('connection cap exceeded')).toHaveLength(1)
  })

  it('catches a crash in one location, redacts the key, and keeps sweeping', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key: 'KEY-AAA', auth_key_fingerprint: 'a'.repeat(64) }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key: 'KEY-BBB', auth_key_fingerprint: 'b'.repeat(64) }),
      ],
      devices: [dev({ id: 'dB', location_id: 'loc-B', device_id: 'bbb1' })],
      fail: { devicesThrow: 'pg exploded while using KEY-AAA', devicesThrowAt: 'loc-A' },
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(out).toMatchObject({ ok: true, locations: 2, crashed: 1 })
    const logged = JSON.stringify(logError.mock.calls)
    expect(logged).toContain('[redacted]')
    expect(logged).not.toContain('KEY-AAA')
    // loc-B was reconciled regardless.
    expect(calls.get).toEqual([{ loc: 'loc-B', ids: ['bbb1'] }])
  })

  it('refuses the whole tick on a non-finite clock, touching nothing', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: [dev()] })
    const out = await runShellyReconcile(db, deps({ now: () => NaN, makeClient: factory }))
    expect(out).toEqual({ ok: false, reason: 'bad_clock' })
    expect(db.reads.fromCalls).toEqual([])
    expect(factory).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })

  // The reason this file groups at all: one Shelly account is ONE 1 req/sec
  // budget, however many studios hang off it.
  it('serialises locations that share an account, and parallelises ones that do not', async () => {
    const sameKey = 'k'.repeat(64)
    const shared = makeClientFactory()
    const dbShared = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key_fingerprint: sameKey }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key_fingerprint: sameKey }),
      ],
      devices: [dev({ id: 'dA', location_id: 'loc-A', device_id: 'aaa1', schedule_mode: 'none' }),
        dev({ id: 'dB', location_id: 'loc-B', device_id: 'bbb1', schedule_mode: 'none' })],
    })
    await runShellyReconcile(dbShared, deps({ makeClient: shared.factory }))
    expect(shared.peak()).toBe(1)

    const split = makeClientFactory()
    const dbSplit = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key_fingerprint: 'a'.repeat(64) }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key_fingerprint: 'b'.repeat(64) }),
      ],
      devices: [dev({ id: 'dA', location_id: 'loc-A', device_id: 'aaa1', schedule_mode: 'none' }),
        dev({ id: 'dB', location_id: 'loc-B', device_id: 'bbb1', schedule_mode: 'none' })],
    })
    await runShellyReconcile(dbSplit, deps({ makeClient: split.factory }))
    expect(split.peak()).toBe(2)
  })

  // An unknown account is not a licence to run in parallel with one it might
  // share a budget with.
  it('folds connections with no fingerprint into ONE serial group', async () => {
    const { factory, peak } = makeClientFactory()
    const db = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key_fingerprint: null }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key_fingerprint: '' }),
      ],
      devices: [dev({ id: 'dA', location_id: 'loc-A', device_id: 'aaa1', schedule_mode: 'none' }),
        dev({ id: 'dB', location_id: 'loc-B', device_id: 'bbb1', schedule_mode: 'none' })],
    })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(peak()).toBe(1)
  })

  // Each location builds a FRESH client, and a fresh client believes it has
  // never called — so without an explicit gap the next location's first request
  // lands inside the previous one's second and buys a guaranteed 429 + retry, on
  // every handoff, forever.
  it('sleeps one gap when handing an account budget between two of its locations', async () => {
    const sameKey = 'k'.repeat(64)
    const sleep = vi.fn(async () => {})
    const devices = [
      dev({ id: 'dA', location_id: 'loc-A', device_id: 'aaa1', schedule_mode: 'none' }),
      dev({ id: 'dB', location_id: 'loc-B', device_id: 'bbb1', schedule_mode: 'none' }),
    ]
    const shared = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key_fingerprint: sameKey }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key_fingerprint: sameKey }),
      ],
      devices,
    })
    await runShellyReconcile(shared, deps({ makeClient: makeClientFactory().factory, sleep }))
    expect(sleep.mock.calls.filter((c) => c[0] === MIN_GAP_MS)).toHaveLength(1)

    // Different accounts are different budgets: no gap owed, and none paid.
    sleep.mockClear()
    const split = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key_fingerprint: 'a'.repeat(64) }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key_fingerprint: 'b'.repeat(64) }),
      ],
      devices,
    })
    await runShellyReconcile(split, deps({ makeClient: makeClientFactory().factory, sleep }))
    expect(sleep.mock.calls.filter((c) => c[0] === MIN_GAP_MS)).toHaveLength(0)

    // Past the deadline every remaining location skips itself, so handing over a
    // budget nobody will spend only makes an overrunning tick overrun by longer.
    sleep.mockClear()
    const late = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key_fingerprint: sameKey }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key_fingerprint: sameKey }),
      ],
      devices,
    })
    await runShellyReconcile(late, deps({ makeClient: makeClientFactory().factory, sleep, budgetMs: -1000 }))
    expect(sleep.mock.calls.filter((c) => c[0] === MIN_GAP_MS)).toHaveLength(0)
  })

  it('parks a failing connection for the shorter window, then sweeps it', async () => {
    expect(ERROR_RETRY_MS).toBeLessThan(ACTION_NEEDED_RETRY_MS)
    const recent = makeDb({ connections: [conn({ status: 'error', last_error_at: iso(NOW - 2 * 60_000) })], devices: [dev()] })
    expect(await runShellyReconcile(recent, deps({ makeClient: makeClientFactory().factory }))).toMatchObject({ locations: 0, parked: 1 })

    const stale = makeDb({ connections: [conn({ status: 'error', last_error_at: iso(NOW - 6 * 60_000) })], devices: [dev()] })
    expect(await runShellyReconcile(stale, deps({ makeClient: makeClientFactory().factory }))).toMatchObject({ locations: 1, parked: 0 })
  })

  // A budget shortfall must rotate through the estate, not starve the same tail.
  it('sweeps oldest-success-first, deterministically', async () => {
    const db = makeDb({ connections: [conn()], devices: [] })
    await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    const orders = db.reads.connectionCalls.filter((c) => c[0] === 'order').map((c) => c[1])
    expect(orders).toEqual([['last_ok_at', { ascending: true, nullsFirst: true }], ['created_at']])
    expect(callArgs(db.reads.connectionCalls, 'select')[0]).toContain('last_ok_at')
  })

  it('makes no call at all once the budget is spent, and says so once', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: [dev()] })
    const out = await runShellyReconcile(db, deps({ makeClient: factory, budgetMs: -1000 }))
    expect(factory).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, locations: 1, reads: 0, applied: 0, failed: 0, deadlineSkipped: 1 })
    expect(warned('time budget exhausted')).toHaveLength(1)
    expect(db.writes.connectionUpdates).toEqual([])
  })
})

// ================================================================== reads

describe('reads', () => {
  it('batches by READ_BATCH and asks for each DEVICE once, not each row', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      dev({ id: `d${i}`, device_id: `mac${String(i).padStart(4, '0')}`, schedule_mode: 'none' }))
    // A second channel of a device already in the list: one more row, no more ids.
    rows.push(dev({ id: 'd0b', device_id: 'mac0000', channel: 1, schedule_mode: 'none' }))
    const { factory, calls } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: rows })

    await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(calls.get.map((c) => c.ids.length)).toEqual([READ_BATCH, 2])
    expect(new Set(calls.get.flatMap((c) => c.ids)).size).toBe(12)
  })

  it('writes last_state only when it actually changed', async () => {
    const db = makeDb({
      connections: [conn()],
      devices: [
        dev({ id: 'same', device_id: 'mac1', schedule_mode: 'none', last_state: settledState() }),
        dev({ id: 'moved', device_id: 'mac2', schedule_mode: 'none', last_state: { ...settledState(), output: false } }),
      ],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    const writes = stateWritesOf(db)
    expect(writes.map((w) => w.id)).toEqual(['moved'])
    expect(out.stateWrites).toBe(1)
  })

  it('an offline device keeps its last measurements and does NOT advance last_seen_at', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: [item(ids[0], [{ channel: 0 }], false)] }) })
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'd1', device_id: 'mac1', schedule_mode: 'none', last_state: settledState() })],
    })
    await runShellyReconcile(db, deps({ makeClient: factory }))

    const w = stateWritesOf(db)[0]
    expect(w.patch.last_state).toMatchObject({ online: false, output: true, apower: 12.5, aenergy_wh: 1000 })
    expect(w.patch).not.toHaveProperty('last_seen_at')
    expect(w.patch.updated_at).toBe(iso(NOW))
  })

  it('advances last_seen_at for a device that actually spoke', async () => {
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
    await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(stateWritesOf(db)[0].patch.last_seen_at).toBe(iso(NOW))
  })

  // The account answered and did not mention it — that IS evidence of offline.
  it('writes a device offline when a SUCCESSFUL batch omits it', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: [item(ids[0])] }) })
    const db = makeDb({
      connections: [conn()],
      devices: [
        dev({ id: 'heard', device_id: 'mac1', schedule_mode: 'none' }),
        dev({ id: 'silent', device_id: 'mac2', schedule_mode: 'none' }),
      ],
    })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    const byId = Object.fromEntries(stateWritesOf(db).map((w) => [w.id, w.patch.last_state.online]))
    expect(byId).toEqual({ heard: true, silent: false })
  })

  // A failed read is not evidence about anything. Batch 2 fails AFTER batch 1
  // succeeded, which is the blip case: the loop carries on (only a failure with
  // no success behind it is treated as a black hole) and batch 1's devices are
  // still written.
  it('never writes a device whose batch FAILED, and still writes the batches that worked', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      dev({ id: `d${i}`, device_id: `mac${String(i).padStart(4, '0')}`, schedule_mode: 'none' }))
    const { factory } = makeClientFactory({
      get: ({ ids, n }) => (n === 2 ? { ok: false, kind: 'network', statusCode: 0 } : okGet(ids)),
    })
    const db = makeDb({ connections: [conn()], devices: rows })

    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(stateWritesOf(db).map((w) => w.id)).toEqual(rows.slice(0, 10).map((r) => r.id))
    expect(out).toMatchObject({ reads: 2, readFailures: 1, stateWrites: 10 })
  })

  // The other half of that rule: with NO success behind it, one failure is the
  // account not answering, and the remaining batches would each spend a slot of
  // the shared budget learning the same thing.
  it('stops at the first failed batch when nothing has succeeded, and sends no commands', async () => {
    const rows = Array.from({ length: 45 }, (_, i) =>
      dev({ id: `d${i}`, device_id: `mac${String(i).padStart(4, '0')}` }))
    const { factory, calls } = makeClientFactory({ get: () => ({ ok: false, kind: 'network', statusCode: 0 }) })
    const db = makeDb({ connections: [conn()], devices: rows })

    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(calls.get).toHaveLength(1)
    expect(calls.setGroups).toEqual([])
    expect(out).toMatchObject({ reads: 1, readFailures: 1, planned: 0, applied: 0, stateWrites: 0 })
    expect(warned('no read succeeded')).toHaveLength(1)
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'error' })
  })

  it('reads one id for a device adopted at two channels, and commands both', async () => {
    const { factory, calls } = makeClientFactory({
      get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0 }, { channel: 1 }])) }),
    })
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'ch0', device_id: 'mac1', channel: 0 }), dev({ id: 'ch1', device_id: 'mac1', channel: 1 })],
    })

    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(calls.get).toEqual([{ loc: 'loc-A', ids: ['mac1'] }])
    expect(calls.setGroups[0].gids).toEqual(['mac1_0', 'mac1_1'])
    expect(out).toMatchObject({ applied: 2, reads: 1 })
  })

  it('counts a 429 and a retried success alike', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ...okGet(ids), retried: true }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ schedule_mode: 'none' })] })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(out.rateLimited).toBe(1)
  })

  it('shouts when a whole location reads offline (the unverified v2 online field)', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0 }], false)) }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ schedule_mode: 'none', last_state: settledState() })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(warned('every device reads offline')).toHaveLength(1)
  })

  it('names the id echo when every covered id comes back unmentioned', async () => {
    const { factory } = makeClientFactory({ get: () => ({ ok: true, statusCode: 200, body: [item('someoneelse')] }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none', last_state: settledState() })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(warned('check the v2 id echo')).toHaveLength(1)
    expect(warned('check the v2 online field')).toHaveLength(0)
  })

  // The tick after adopt is the one that can name a broken integration, and a
  // device that has never been read has last_state null — so it must count as
  // part of the transition, or both diagnostics stay silent through the single
  // tick that mattered while every new device is written offline.
  it('fires either diagnostic on a day-one device that has never been read', async () => {
    for (const [get, fragment] of [
      [({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0 }], false)) }), 'check the v2 online field'],
      [() => ({ ok: true, statusCode: 200, body: [item('someoneelse')] }), 'check the v2 id echo'],
    ]) {
      vi.clearAllMocks()
      const { factory } = makeClientFactory({ get })
      const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none', last_state: null })] })
      await runShellyReconcile(db, deps({ makeClient: factory }))
      expect(warned(fragment)).toHaveLength(1)
    }
  })

  // Both diagnostics fire on the TRANSITION and then go quiet: a studio that is
  // genuinely dark overnight must not log the same line 1,440 times, or the line
  // that means "the integration is broken" is the one everybody filters out.
  it('says nothing on the next tick, once every device is already known offline', async () => {
    const dark = { ...settledState(), online: false }
    for (const script of [
      { get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0 }], false)) }),
        fragment: 'every device reads offline' },
      { get: () => ({ ok: true, statusCode: 200, body: [item('someoneelse')] }), fragment: 'check the v2 id echo' },
    ]) {
      vi.clearAllMocks()
      const { factory } = makeClientFactory({ get: script.get })
      const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none', last_state: dark })] })
      await runShellyReconcile(db, deps({ makeClient: factory }))
      expect(warned(script.fragment)).toHaveLength(0)
    }
  })

  it('warns and slices at the device cap', async () => {
    const rows = Array.from({ length: MAX_DEVICES + 1 }, (_, i) =>
      dev({ id: `d${i}`, device_id: `mac${String(i).padStart(4, '0')}`, schedule_mode: 'none' }))
    const { factory, calls } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: rows })

    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(warned('device cap exceeded')).toHaveLength(1)
    expect(calls.get.flatMap((c) => c.ids)).toHaveLength(MAX_DEVICES)
    expect(out.devices).toBe(MAX_DEVICES)
  })

  it('refreshLocationState stands alone for PR 2 (no deadline, its own client)', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ devices: [] })
    const out = await refreshLocationState(db, conn(), [dev({ device_id: 'mac1' })], { now: () => NOW, makeClient: factory })
    expect(out).toMatchObject({ reads: 1, readFailures: 0, stateWrites: 1, anyOk: true, auth: false, config: false })
    expect(out.covered.has('mac1')).toBe(true)
  })
})

// ================================================================== commands

describe('commands', () => {
  it('sends ONE setGroups for everything opening, and none for a group that is empty', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'd1', device_id: 'mac1' }), dev({ id: 'd2', device_id: 'mac2', channel: 1 })],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(calls.setGroups).toHaveLength(1)
    expect(calls.setGroups[0]).toMatchObject({ on: true, gids: ['mac1_0', 'mac2_1'] })
    expect(out).toMatchObject({ planned: 2, applied: 2, failed: 0 })
    expect(stampsOf(db).map((w) => w.patch.last_applied.reason)).toEqual(['window_open', 'window_open'])
  })

  it('opens before it closes, one call each', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({
      connections: [conn()],
      devices: [
        dev({ id: 'opening', device_id: 'mac1' }),
        dev({
          id: 'closing', device_id: 'mac2',
          fixed_windows: [{ days: [1], on: '22:00', off: '23:00' }],
          last_applied: { key: 'w:1', action: 'on', reason: 'window_open', at: iso(NOW - HOUR) },
        }),
      ],
    })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(calls.setGroups.map((c) => [c.on, c.gids])).toEqual([[true, ['mac1_0']], [false, ['mac2_0']]])
  })

  it('never stamps a device the API listed in failedCommands', async () => {
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: true, statusCode: 200, failed: { mac2_0: 'DEVICE_OFFLINE' } }) })
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'ok', device_id: 'mac1' }), dev({ id: 'bad', device_id: 'mac2' })],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(stampsOf(db).map((w) => w.id)).toEqual(['ok'])
    expect(out).toMatchObject({ applied: 1, failed: 1 })
    expect(warned('command failed')).toHaveLength(1)
  })

  // Absence is only evidence while the map is keyed the way we key our gids.
  // A key from any other id space means "this response is not the shape the
  // stamp reads", and stamping the batch anyway is the optimistic stamp that
  // costs the whole window.
  it('stamps nothing when failedCommands carries a key from this batch it cannot be about', async () => {
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: true, statusCode: 200, failed: { 'weird-key': 'X' } }) })
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'a', device_id: 'mac1' }), dev({ id: 'b', device_id: 'mac2' })],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(stampsOf(db)).toEqual([])
    expect(out).toMatchObject({ applied: 0, failed: 2 })
    expect(warned('failedCommands keyed in an unrecognised shape')).toHaveLength(1)
    // One key, truncated — never the map, which came out of a response body.
    expect(logWarn.mock.calls.at(-1)[2]).toMatchObject({ locationId: 'loc-A', sample: 'weird-key' })
  })

  // The client turns a 2xx body carrying a top-level error into kind 'device' —
  // the whole batch failed, not part of it.
  it('treats a device-kind batch failure as the whole batch failing', async () => {
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: false, kind: 'device', code: 'BAD_REQUEST', statusCode: 200 }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ id: 'a', device_id: 'mac1' }), dev({ id: 'b', device_id: 'mac2' })] })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(stampsOf(db)).toEqual([])
    expect(out.failed).toBe(2)
  })

  it('counts a failed stamp as failed rather than reporting the command applied', async () => {
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1' })], fail: { deviceUpdate: 'stamp write down' } })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(out).toMatchObject({ applied: 0, failed: 1 })
    expect(warned('last_applied write failed')).toHaveLength(1)
  })

  // groupId throws on a malformed row, on purpose. One such row must not take
  // the location's healthy devices down with it, every minute, forever.
  it('isolates a device row with no usable group id', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'good', device_id: 'mac1' }), dev({ id: 'broken', device_id: 'mac2', channel: null })],
    })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(calls.setGroups[0].gids).toEqual(['mac1_0'])
    expect(out).toMatchObject({ applied: 1, failed: 1 })
    expect(warned('unusable device row')).toHaveLength(1)
  })
})

// ================================================================== energy

describe('energy roll', () => {
  it('upserts in bulk on (device_id, day), keyed by the LOCATION day, with both ids stamped', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0, total: 1500 }])) }) })
    const db = makeDb({
      connections: [conn({ id: 'cNY', location_id: 'loc-NY', locations: { timezone: 'America/New_York' } })],
      devices: [dev({ id: 'dNY', location_id: 'loc-NY', device_id: 'mac1', schedule_mode: 'none' })],
      energy: [{ device_id: 'dNY', location_id: 'loc-NY', day: '2026-07-06', wh_start: '1000.000', wh_last: '1400.000', wh_total: '400.000', samples: 5, resets: 0, first_sample_at: iso(NOW_NY - HOUR), last_sample_at: iso(NOW_NY - 60_000) }],
    })

    const out = await runShellyReconcile(db, deps({ now: () => NOW_NY, makeClient: factory }))

    expect(db.writes.energyUpserts).toHaveLength(1)
    const { rows, opts } = db.writes.energyUpserts[0]
    expect(opts).toEqual({ onConflict: 'device_id,day' })
    // 23:30 in New York is still the 6th, even though UTC says the 7th.
    expect(rows[0]).toMatchObject({
      device_id: 'dNY', location_id: 'loc-NY', day: '2026-07-06',
      wh_last: 1500, wh_total: 500, samples: 6, last_sample_at: iso(NOW_NY),
    })
    expect(out.energyWrites).toBe(1)
  })

  // energy.js only banks a gap into today while the caller still hands it the
  // last row — the load WINDOW is that promise's reach.
  it('carries a row five days old (the lookback window includes it)', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0, total: 1500 }])) }) })
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'd1', device_id: 'mac1', schedule_mode: 'none' })],
      energy: [{ device_id: 'd1', location_id: 'loc-A', day: '2026-07-01', wh_start: '900.000', wh_last: '1400.000', wh_total: '500.000', samples: 40, resets: 0, first_sample_at: iso(NOW - 5 * 24 * HOUR), last_sample_at: iso(NOW - 5 * 24 * HOUR) }],
    })

    await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(db.reads.energyBounds).toEqual(['2026-06-29', '2026-07-06'])
    expect(ENERGY_LOOKBACK_DAYS).toBe(7)
    expect(db.writes.energyUpserts[0].rows[0]).toMatchObject({ day: '2026-07-06', wh_start: 1400, wh_last: 1500, wh_total: 100, samples: 1 })
  })

  it('picks the LATEST row per device when several days are in the window', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0, total: 2000 }])) }) })
    const base = { device_id: 'd1', location_id: 'loc-A', wh_start: '0', wh_total: '0', samples: 1, resets: 0, first_sample_at: iso(NOW - HOUR), last_sample_at: iso(NOW - HOUR) }
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'd1', device_id: 'mac1', schedule_mode: 'none' })],
      energy: [{ ...base, day: '2026-07-02', wh_last: '100.000' }, { ...base, day: '2026-07-05', wh_last: '1900.000' }],
    })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.energyUpserts[0].rows[0]).toMatchObject({ wh_start: 1900, wh_total: 100 })
  })

  // supabase-js sets `columns=` to the UNION of every row's keys, and a key a
  // row does not carry is then inserted as NULL. rollDailyEnergy builds a
  // continuing day by SPREADING yesterday's row and a new day from a clean
  // literal — so the two branches must agree on their column set, or the day
  // rollover starts NULLing whatever the round-trip happened to carry. They
  // agree today; this pins it, because the failure is a nightly one.
  it('emits the same columns whichever rollDailyEnergy branch built the row', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0, total: 1500 }])) }) })
    const db = makeDb({
      connections: [conn()],
      devices: [
        dev({ id: 'continuing', device_id: 'mac1', schedule_mode: 'none' }),
        dev({ id: 'fresh', device_id: 'mac2', schedule_mode: 'none' }),
      ],
      energy: [{ device_id: 'continuing', location_id: 'loc-A', day: '2026-07-06', wh_start: '1000.000', wh_last: '1400.000', wh_total: '400.000', samples: 5, resets: 0, first_sample_at: iso(NOW - HOUR), last_sample_at: iso(NOW - 60_000) }],
    })

    await runShellyReconcile(db, deps({ makeClient: factory }))

    const [a, b] = db.writes.energyUpserts[0].rows
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
    expect(Object.keys(a).sort()).toEqual([
      'day', 'device_id', 'first_sample_at', 'last_sample_at', 'location_id',
      'resets', 'samples', 'wh_last', 'wh_start', 'wh_total',
    ])
  })

  it('scopes the window to THESE devices, newest day first, with a decidable cap', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ id: 'd1', device_id: 'mac1', schedule_mode: 'none' }), dev({ id: 'd2', device_id: 'mac2', schedule_mode: 'none' })],
    })
    await runShellyReconcile(db, deps({ makeClient: factory }))

    const calls = db.reads.energyCalls
    expect(callArgs(calls, 'in')).toEqual(['device_id', ['d1', 'd2']])
    expect(callArgs(calls, 'order')).toEqual(['day', { ascending: false }])
    expect(callArgs(calls, 'limit')).toEqual([2 * (ENERGY_LOOKBACK_DAYS + 1) + 1])
    // An explicit projection, never '*' — see ENERGY_COLUMNS: the round-trip row
    // is spread straight back into the bulk upsert.
    const projection = callArgs(calls, 'select')[0]
    expect(projection).not.toBe('*')
    expect(projection).toBe('device_id, location_id, day, wh_start, wh_last, wh_total, samples, resets, first_sample_at, last_sample_at')
    // The worst case a full location can produce still clears PostgREST's 1k cap.
    expect(ENERGY_ROW_CAP).toBe(MAX_DEVICES * (ENERGY_LOOKBACK_DAYS + 1))
    expect(ENERGY_ROW_CAP).toBeLessThan(1000)
  })

  it('says so when the window returns more rows than the location can own', async () => {
    const { factory } = makeClientFactory()
    const rows = Array.from({ length: ENERGY_LOOKBACK_DAYS + 2 }, (_, i) => ({
      device_id: 'd1', location_id: 'loc-A', day: `2026-06-${String(20 + i).padStart(2, '0')}`,
      wh_start: '0', wh_last: '0', wh_total: '0', samples: 1, resets: 0,
      first_sample_at: iso(NOW - HOUR), last_sample_at: iso(NOW - HOUR),
    }))
    const db = makeDb({ connections: [conn()], devices: [dev({ id: 'd1', device_id: 'mac1', schedule_mode: 'none' })], energy: rows })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(warned('more rows than this location can own')).toHaveLength(1)
  })

  it('never samples an offline device', async () => {
    const { factory } = makeClientFactory({ get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => item(id, [{ channel: 0, total: 1500 }], false)) }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.energyUpserts).toEqual([])
  })

  it('never samples a channel with no meter', async () => {
    const { factory } = makeClientFactory({
      get: ({ ids }) => ({ ok: true, statusCode: 200, body: ids.map((id) => ({ ...item(id), status: { 'switch:0': { output: true, source: 'cloud' } } })) }),
    })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.energyUpserts).toEqual([])
  })

  // Rolling against an empty baseline would REPLACE today's row with a fresh
  // one: samples 1, wh_total 0. The day's total would simply vanish.
  it('skips the roll entirely when the baseline could not be loaded', async () => {
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })],
      fail: { energy: 'pg down' },
    })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(db.writes.energyUpserts).toEqual([])
    expect(out.energyWrites).toBe(0)
    expect(warned('energy not rolled this tick')).toHaveLength(1)
  })

  it('reports an upsert failure without claiming the writes happened', async () => {
    const db = makeDb({
      connections: [conn()],
      devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })],
      fail: { energyUpsert: 'check violation' },
    })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(out.energyWrites).toBe(0)
    expect(warned('energy upsert failed')).toHaveLength(1)
  })
})

// ================================================================== planning

describe('planning', () => {
  const classDev = (over = {}) => dev({ schedule_mode: 'class', fixed_windows: null, class_rule: { lead_min: 15, lag_min: 10 }, ...over })

  it('skips class devices when the timetable could not be loaded, and still plans fixed ones', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({
      connections: [conn()],
      devices: [
        classDev({ id: 'plain', device_id: 'mac1' }),
        classDev({ id: 'expired', device_id: 'mac2', override: { state: 'on', until: iso(NOW - HOUR), set_at: 'S-old' } }),
        classDev({ id: 'live', device_id: 'mac3', override: { state: 'on', until: iso(NOW + HOUR), set_at: 'S-new' } }),
        dev({ id: 'fixed', device_id: 'mac4' }),
      ],
    })

    const out = await runShellyReconcile(db, deps({
      makeClient: factory,
      loadOccurrences: async () => ({ ok: false, error: 'pg down' }),
    }))

    expect(out.skippedClass).toBe(2)
    // The live override is applied (it never depended on the timetable); the
    // expired one is not a reason to bypass the skip.
    expect(calls.setGroups[0].gids).toEqual(['mac3_0', 'mac4_0'])
    expect(warned('occurrence load failed')).toHaveLength(1)
    expect(stampsOf(db).find((w) => w.id === 'live').patch.last_applied).toMatchObject({ key: 'ov:S-new', action: 'on', reason: 'override' })
  })

  it('does not load the timetable at all when no device is in class mode', async () => {
    const loadOccurrences = vi.fn(async () => ({ ok: true, occurrences: [] }))
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1' })] })
    await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory, loadOccurrences }))
    expect(loadOccurrences).not.toHaveBeenCalled()
  })

  it('opens a class device from its occurrences', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: [classDev({ device_id: 'mac1' })] })
    await runShellyReconcile(db, deps({
      makeClient: factory,
      loadOccurrences: async () => ({ ok: true, occurrences: [{ starts_at: iso(NOW + 10 * 60_000), ends_at: iso(NOW + 55 * 60_000), cancelled_at: null }] }),
    }))
    expect(calls.setGroups[0]).toMatchObject({ on: true, gids: ['mac1_0'] })
  })

  it('applies a live override to a DISABLED device exactly once', async () => {
    const override = { state: 'on', until: iso(NOW + HOUR), set_at: 'S1' }
    const first = makeClientFactory()
    const db1 = makeDb({ connections: [conn()], devices: [dev({ id: 'd1', device_id: 'mac1', enabled: false, override })] })
    const out1 = await runShellyReconcile(db1, deps({ makeClient: first.factory }))
    expect(out1).toMatchObject({ planned: 1, applied: 1 })
    expect(first.calls.setGroups[0]).toMatchObject({ on: true, gids: ['mac1_0'] })

    const stamped = stampsOf(db1)[0].patch.last_applied
    const second = makeClientFactory()
    const db2 = makeDb({ connections: [conn()], devices: [dev({ id: 'd1', device_id: 'mac1', enabled: false, override, last_applied: stamped })] })
    const out2 = await runShellyReconcile(db2, deps({ makeClient: second.factory }))
    expect(out2.planned).toBe(0)
    expect(second.calls.setGroups).toEqual([])
  })
})

// ================================================================== connection status

describe('connection status', () => {
  it('marks connected after a successful read', async () => {
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
    await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(db.writes.connectionUpdates).toEqual([{ id: 'c1', patch: { status: 'connected', last_ok_at: iso(NOW), last_error: null, last_error_at: null, updated_at: iso(NOW) } }])
  })

  // last_error and last_error_at are ONE fact. A recovery that clears only the
  // text leaves a timestamp the sweep's park windows are computed from, so the
  // next real failure is measured against a failure that already healed.
  it('clears last_error_at as well as last_error when a failed connection recovers', async () => {
    const db = makeDb({
      connections: [conn({ status: 'error', last_error_at: iso(NOW - ERROR_RETRY_MS - 1) })],
      devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })],
    })
    await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'connected', last_error: null, last_error_at: null })
  })

  it('marks error with the KIND and nothing else after an unreachable read', async () => {
    const { factory } = makeClientFactory({ get: () => ({ ok: false, kind: 'network', statusCode: 0 }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'error', last_error: 'Shelly unreachable (network)' })
  })

  it('never touches the connection for a location with nothing adopted', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: [] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.connectionUpdates).toEqual([])
    expect(factory).not.toHaveBeenCalled()
  })

  it('an auth failure parks the connection, writes no device, and does not stop the other studio', async () => {
    const { factory, calls } = makeClientFactory({ get: ({ ids, loc }) => (loc === 'loc-A' ? { ok: false, kind: 'auth', statusCode: 401 } : okGet(ids)) })
    const db = makeDb({
      connections: [
        conn({ id: 'c1', location_id: 'loc-A', auth_key: 'KEY-AAA', auth_key_fingerprint: 'a'.repeat(64) }),
        conn({ id: 'c2', location_id: 'loc-B', auth_key: 'KEY-BBB', auth_key_fingerprint: 'b'.repeat(64) }),
      ],
      devices: [
        dev({ id: 'dA', location_id: 'loc-A', device_id: 'aaa1' }),
        dev({ id: 'dB', location_id: 'loc-B', device_id: 'bbb1', schedule_mode: 'none' }),
      ],
    })

    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    const parked = db.writes.connectionUpdates.find((w) => w.id === 'c1')
    expect(parked.patch).toMatchObject({ status: 'action_needed', last_error: AUTH_ERROR, last_error_at: iso(NOW) })
    expect(JSON.stringify(db.writes.connectionUpdates)).not.toContain('KEY-AAA')
    expect(db.writes.deviceUpdates.map((w) => w.id)).toEqual(['dB'])
    expect(calls.setGroups).toEqual([])
    expect(out).toMatchObject({ authFailures: 1, locations: 2 })
    expect(db.writes.connectionUpdates.find((w) => w.id === 'c2').patch.status).toBe('connected')
  })

  it('a bad stored host is action_needed with the host message, not a retry-forever error', async () => {
    const { factory } = makeClientFactory({ get: () => ({ ok: false, kind: 'config', statusCode: 0 }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'action_needed', last_error: HOST_ERROR })
    expect(stateWritesOf(db)).toEqual([])
  })

  it('parks the connection when the command call is the thing that gets a 401', async () => {
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: false, kind: 'auth', statusCode: 401 }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1' })] })
    const out = await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'action_needed', last_error: AUTH_ERROR })
    expect(out).toMatchObject({ authFailures: 1, failed: 1, applied: 0 })
  })

  it('leaves a rate-limited batch unstamped and names the budget in the status', async () => {
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: false, kind: 'rate_limited', statusCode: 429 }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ id: 'a', device_id: 'mac1' }), dev({ id: 'b', device_id: 'mac2' })] })

    const out = await runShellyReconcile(db, deps({ makeClient: factory }))

    expect(stampsOf(db)).toEqual([])
    expect(out).toMatchObject({ applied: 0, failed: 2, rateLimited: 1 })
    // The read succeeded, so the account is REACHABLE — but our commands did not
    // land, and a studio whose relays never moved must not show a green badge.
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'error', last_error: RATE_LIMIT_ERROR })
    expect(db.writes.connectionUpdates[0].patch).not.toHaveProperty('last_ok_at')
  })

  it('a bad host on the COMMAND path outranks a read that worked', async () => {
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: false, kind: 'config', statusCode: 0 }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1' })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(db.writes.connectionUpdates[0].patch).toMatchObject({ status: 'action_needed', last_error: HOST_ERROR })
  })

  it('truncates a device error code rather than logging a body', async () => {
    const long = 'X'.repeat(200)
    const { factory } = makeClientFactory({ setGroups: () => ({ ok: true, statusCode: 200, failed: { mac1_0: long } }) })
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1' })] })
    await runShellyReconcile(db, deps({ makeClient: factory }))
    expect(warned('command failed')[0][2].code).toHaveLength(64)
  })

  it('logs but survives a failed connection status write', async () => {
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })], fail: { connectionUpdate: 'pg down' } })
    const out = await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
    expect(out.ok).toBe(true)
    expect(warned('connection status write failed')).toHaveLength(1)
  })
})

// ================================================================== timezone

describe('timezone', () => {
  it('falls back to Dublin and names the location and the rejected value', async () => {
    const db = makeDb({
      connections: [conn({ locations: { timezone: 'Europe/Dubln' } })],
      devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })],
    })
    await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))

    const hits = warned('unknown location timezone')
    expect(hits).toHaveLength(1)
    expect(hits[0][2]).toMatchObject({ locationId: 'loc-A', timezone: 'Europe/Dubln', using: 'Europe/Dublin' })
  })

  it('says nothing for a null timezone or a case variant of a real one', async () => {
    for (const timezone of [null, 'europe/dublin']) {
      vi.clearAllMocks()
      const db = makeDb({ connections: [conn({ locations: { timezone } })], devices: [dev({ device_id: 'mac1', schedule_mode: 'none' })] })
      await runShellyReconcile(db, deps({ makeClient: makeClientFactory().factory }))
      expect(warned('unknown location timezone')).toHaveLength(0)
    }
  })
})

// ================================================================== occurrences

describe('loadTodayOccurrences', () => {
  it('bounds the query to the LOCATION day, not the UTC one', async () => {
    const db = makeDb({ occurrences: [{ starts_at: iso(NOW_NY), ends_at: iso(NOW_NY + HOUR), cancelled_at: null }] })
    const out = await loadTodayOccurrences(db, 'loc-NY', 'America/New_York', NOW_NY)
    expect(out.ok).toBe(true)
    expect(out.occurrences).toHaveLength(1)
    expect(db.reads.occurrenceBounds).toEqual(['2026-07-06T04:00:00.000Z', '2026-07-07T04:00:00.000Z'])
  })

  it('bounds a Dublin day across the IST offset', async () => {
    const db = makeDb({ occurrences: [] })
    await loadTodayOccurrences(db, 'loc-A', 'Europe/Dublin', NOW)
    expect(db.reads.occurrenceBounds).toEqual(['2026-07-05T23:00:00.000Z', '2026-07-06T23:00:00.000Z'])
  })

  it('reports a load error rather than an empty timetable', async () => {
    const db = makeDb({ fail: { occurrences: 'pg down' } })
    expect(await loadTodayOccurrences(db, 'loc-A', 'Europe/Dublin', NOW)).toEqual({ ok: false, error: 'pg down' })
  })

  it('refuses an unreadable clock instead of throwing at its caller', async () => {
    const db = makeDb({})
    expect(await loadTodayOccurrences(db, 'loc-A', 'Europe/Dublin', NaN)).toEqual({ ok: false, error: 'unusable clock' })
    expect(db.reads.fromCalls).toEqual([])
  })

  // Same sentinel treatment as the connection, device and energy selects: ask
  // for cap + 1 so a truncated timetable is decidable rather than silent. A
  // dropped occurrence is a class whose window never opens.
  it('asks for one row past the cap and says so when the timetable is truncated', async () => {
    const many = Array.from({ length: MAX_OCCURRENCES + 1 }, (_, i) => ({
      starts_at: iso(NOW + i * 60_000), ends_at: iso(NOW + i * 60_000 + HOUR), cancelled_at: null,
    }))
    const db = makeDb({ occurrences: many })
    const out = await loadTodayOccurrences(db, 'loc-A', 'Europe/Dublin', NOW)

    expect(callArgs(db.reads.occurrenceCalls, 'limit')).toEqual([MAX_OCCURRENCES + 1])
    // The sentinel row never reaches the planner.
    expect(out.occurrences).toHaveLength(MAX_OCCURRENCES)
    expect(warned('occurrence cap exceeded')).toHaveLength(1)
  })

  it('says nothing at exactly the cap — the boundary is not a truncation', async () => {
    const many = Array.from({ length: MAX_OCCURRENCES }, (_, i) => ({
      starts_at: iso(NOW + i * 60_000), ends_at: iso(NOW + i * 60_000 + HOUR), cancelled_at: null,
    }))
    const out = await loadTodayOccurrences(makeDb({ occurrences: many }), 'loc-A', 'Europe/Dublin', NOW)
    expect(out.occurrences).toHaveLength(MAX_OCCURRENCES)
    expect(warned('occurrence cap exceeded')).toHaveLength(0)
  })
})

// ================================================================== run now

describe('runNowForDevice', () => {
  it('switches the device and stamps the run', async () => {
    const { factory, calls } = makeClientFactory()
    const db = makeDb({})
    const out = await runNowForDevice(db, conn(), dev({ device_id: 'mac1' }), { now: () => NOW, makeClient: factory })

    expect(out).toEqual({ ok: true, action: 'on', reason: 'run_now' })
    expect(calls.setSwitch).toEqual([{ loc: 'loc-A', id: 'mac1', ch: 0, on: true }])
    expect(db.writes.deviceUpdates[0].patch.last_applied).toMatchObject({ action: 'on', reason: 'run_now' })
  })

  it('re-issues even when the planner has already stamped that key', async () => {
    const { factory } = makeClientFactory()
    const device = dev({ device_id: 'mac1' })
    const stamped = { ...device, last_applied: { key: `w:${Date.parse('2026-07-06T06:00:00Z')}`, action: 'on', reason: 'window_open', at: iso(NOW) } }
    const out = await runNowForDevice(makeDb({}), conn(), stamped, { now: () => NOW, makeClient: factory })
    expect(out).toMatchObject({ ok: true, action: 'on' })
  })

  it('does not stamp when the switch call failed', async () => {
    const { factory } = makeClientFactory({ setSwitch: () => ({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE', statusCode: 200 }) })
    const db = makeDb({})
    const out = await runNowForDevice(db, conn(), dev({ device_id: 'mac1' }), { now: () => NOW, makeClient: factory })
    expect(out).toEqual({ ok: false, kind: 'device', code: 'DEVICE_OFFLINE', statusCode: 200 })
    expect(db.writes.deviceUpdates).toEqual([])
  })

  it('is a no-op for an unmanaged device', async () => {
    const { factory, calls } = makeClientFactory()
    const out = await runNowForDevice(makeDb({}), conn(), dev({ schedule_mode: 'none' }), { now: () => NOW, makeClient: factory })
    expect(out).toEqual({ ok: true, noop: true })
    expect(calls.setSwitch).toEqual([])
  })

  it('refuses rather than forcing an OFF off a timetable it could not read', async () => {
    const { factory, calls } = makeClientFactory()
    const out = await runNowForDevice(makeDb({}), conn(), dev({ schedule_mode: 'class' }), {
      now: () => NOW, makeClient: factory, loadOccurrences: async () => ({ ok: false, error: 'pg down' }),
    })
    expect(out).toEqual({ ok: false, kind: 'occurrences', error: 'pg down' })
    expect(calls.setSwitch).toEqual([])
  })

  it('refuses a device row it could not address', async () => {
    const { factory, calls } = makeClientFactory()
    const out = await runNowForDevice(makeDb({}), conn(), dev({ channel: null }), { now: () => NOW, makeClient: factory })
    expect(out).toEqual({ ok: false, kind: 'bad_device' })
    expect(calls.setSwitch).toEqual([])
  })

  // `bad_device` outranks `noop`: an unmanaged mode is not the reason this row
  // cannot be actioned, and answering `noop` would hide a broken row.
  it('says bad_device, not noop, for a malformed row that is also unmanaged', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({})
    const out = await runNowForDevice(db, conn(), dev({ channel: null, schedule_mode: 'none' }), { now: () => NOW, makeClient: factory })
    expect(out).toEqual({ ok: false, kind: 'bad_device' })
  })

  // ...and it costs no timetable read, because the row could never be commanded.
  it('does not read the timetable for a malformed class device', async () => {
    const loadOccurrences = vi.fn(async () => ({ ok: true, occurrences: [] }))
    const out = await runNowForDevice(makeDb({}), conn(), dev({ device_id: '', schedule_mode: 'class' }), {
      now: () => NOW, makeClient: makeClientFactory().factory, loadOccurrences,
    })
    expect(out).toEqual({ ok: false, kind: 'bad_device' })
    expect(loadOccurrences).not.toHaveBeenCalled()
  })

  it('refuses an unreadable clock', async () => {
    const { factory, calls } = makeClientFactory()
    const out = await runNowForDevice(makeDb({}), conn(), dev(), { now: () => NaN, makeClient: factory })
    expect(out).toEqual({ ok: false, kind: 'bad_clock' })
    expect(calls.setSwitch).toEqual([])
  })

  it('reports a success even when only the stamp failed — the relay did move', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ fail: { deviceUpdate: 'pg down' } })
    const out = await runNowForDevice(db, conn(), dev({ device_id: 'mac1' }), { now: () => NOW, makeClient: factory })
    expect(out).toMatchObject({ ok: true, action: 'on' })
    expect(warned('run-now stamp write failed')).toHaveLength(1)
  })
})

// ================================================================== direct

describe('reconcileLocation (direct)', () => {
  it('returns counters and never throws on a device load error', async () => {
    const db = makeDb({ fail: { devices: 'pg down' } })
    const out = await reconcileLocation(db, conn(), { now: () => NOW, makeClient: makeClientFactory().factory })
    expect(out).toMatchObject({ devices: 0, reads: 0, applied: 0 })
    expect(warned('device load failed')).toHaveLength(1)
  })

  it('skips the location on a non-finite clock rather than switching it all off', async () => {
    const { factory } = makeClientFactory()
    const db = makeDb({ connections: [conn()], devices: [dev({ device_id: 'mac1' })] })
    const out = await reconcileLocation(db, conn(), { now: () => NaN, makeClient: factory })
    expect(out.devices).toBe(0)
    expect(factory).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })
})
