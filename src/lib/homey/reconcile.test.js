// HOMEYD.3 — tests for reportDeviceStates (port of the bridge tapo/state
// route's select→branch loop) and runHomeyReconcile (the per-minute cron
// body) with injected deps. No real env/network/DB — getConfig/getDevices/
// setOnoff are all injectable, and the DB is a tiny in-memory fake modelled
// on class-climate-runner.test.js's makeDb, extended with maybeSingle() and
// error injection so the state-report branch behaviour can be pinned.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { reportDeviceStates, runHomeyReconcile } from './reconcile.js'
import { logWarn } from '@/lib/log'
import { dublinTodayStr, dublinDayStartMs } from '@/lib/dublin-time'

const LOC = 'a0000000-0000-0000-0000-000000000001'

// ── in-memory Supabase fake ────────────────────────────────────────
// Tables are arrays of plain rows. A query builder collects filters, then
// resolves on .maybeSingle()/insert()/update() or on await (select). Error
// injection hooks let a test force a specific select/insert/update to fail
// without derailing every other call in the same test.
function makeDb(tables = {}, hooks = {}) {
  const store = {
    tapo_devices: [],
    class_occurrences: [],
    ...tables,
  }
  const calls = { inserts: [], updates: [] }
  let idSeq = 1

  function builder(table) {
    const filters = []
    let op = 'select'
    let payload = null

    const applyFilters = (rows) =>
      rows.filter((r) =>
        filters.every(([kind, col, val]) => {
          if (kind === 'eq') return r[col] === val
          if (kind === 'gte') return r[col] != null && r[col] >= val
          if (kind === 'lt') return r[col] != null && r[col] < val
          if (kind === 'is') return val === null ? r[col] == null : r[col] === val
          return true
        }),
      )

    function resolveQuery(single) {
      if (op === 'insert') {
        calls.inserts.push({ table, row: payload })
        const err = hooks.insertError?.(table, payload)
        if (err) return Promise.resolve({ data: null, error: err })
        const row = { id: `id-${idSeq++}`, ...payload }
        store[table].push(row)
        return Promise.resolve({ data: row, error: null })
      }
      if (op === 'update') {
        const matched = applyFilters(store[table])
        calls.updates.push({ table, patch: payload, matchedCount: matched.length })
        const err = hooks.updateError?.(table, payload, matched)
        if (err) return Promise.resolve({ data: null, error: err })
        for (const r of matched) Object.assign(r, payload)
        return Promise.resolve({ data: null, error: null })
      }
      // select
      const err = hooks.selectError?.(table, filters)
      if (err) return Promise.resolve({ data: null, error: err })
      const matched = applyFilters(store[table])
      if (single) return Promise.resolve({ data: matched[0] || null, error: null })
      return Promise.resolve({ data: matched, error: null })
    }

    const chain = {
      select() { return chain },
      eq(col, val) { filters.push(['eq', col, val]); return chain },
      gte(col, val) { filters.push(['gte', col, val]); return chain },
      lt(col, val) { filters.push(['lt', col, val]); return chain },
      is(col, val) { filters.push(['is', col, val]); return chain },
      limit() { return chain },
      insert(row) { op = 'insert'; payload = row; return chain },
      update(patch) { op = 'update'; payload = patch; return chain },
      maybeSingle() { return resolveQuery(true) },
      then(resolve, reject) { return resolveQuery(false).then(resolve, reject) },
    }
    return chain
  }
  return { from: (t) => builder(t), _store: store, _calls: calls }
}

beforeEach(() => {
  logWarn.mockClear()
})

// ── reportDeviceStates ───────────────────────────────────────────

describe('reportDeviceStates', () => {
  it('updates an existing device, stamping last_seen_at when reachable', async () => {
    const db = makeDb({
      tapo_devices: [{ id: 'd1', location_id: LOC, sidecar_device_id: 'homey:a', last_state: 'off' }],
    })
    const out = await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:a', state: 'on', reachable: true }])
    expect(out).toEqual({ updated: 1, discovered: 0, failed: 0 })
    const row = db._store.tapo_devices.find((r) => r.id === 'd1')
    expect(row.last_state).toBe('on')
    expect(row.last_seen_at).toBeTruthy()
  })

  it('does NOT stamp last_seen_at when reachable is explicitly false', async () => {
    const db = makeDb({
      tapo_devices: [{ id: 'd1', location_id: LOC, sidecar_device_id: 'homey:a', last_state: 'on', last_seen_at: null }],
    })
    await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:a', state: null, reachable: false }])
    const row = db._store.tapo_devices.find((r) => r.id === 'd1')
    expect(row.last_seen_at).toBeNull()
    expect(row.last_state).toBeNull()
  })

  it('auto-registers an unknown device as disabled (adopt flow)', async () => {
    const db = makeDb()
    const out = await reportDeviceStates(db, LOC, [
      { sidecar_device_id: 'homey:new', state: 'off', reachable: true, kind: 'plug', name_hint: 'New Plug' },
    ])
    expect(out).toEqual({ updated: 0, discovered: 1, failed: 0 })
    expect(db._store.tapo_devices).toHaveLength(1)
    expect(db._store.tapo_devices[0]).toMatchObject({
      location_id: LOC, sidecar_device_id: 'homey:new', kind: 'plug', name: 'New Plug',
      enabled: false, schedule_mode: 'none', last_state: 'off',
    })
  })

  it('defaults kind to plug and name to null when unset on discovery', async () => {
    const db = makeDb()
    await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:bare', state: 'on', reachable: true }])
    expect(db._store.tapo_devices[0]).toMatchObject({ kind: 'plug', name: null })
  })

  it('a failed lookup does NOT fall through to insert (counts as failed, no row created)', async () => {
    const db = makeDb({}, { selectError: () => ({ message: 'connection reset' }) })
    const out = await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:a', state: 'on', reachable: true }])
    expect(out).toEqual({ updated: 0, discovered: 0, failed: 1 })
    expect(db._store.tapo_devices).toHaveLength(0)
    expect(logWarn).toHaveBeenCalledWith('homey-reconcile', 'device lookup failed', expect.objectContaining({ sidecarDeviceId: 'homey:a' }))
  })

  it('an insert 23505 (benign concurrent-registration race) falls back to update', async () => {
    let insertAttempted = false
    const db = makeDb(
      { tapo_devices: [] },
      {
        insertError: () => {
          if (insertAttempted) return null
          insertAttempted = true
          // Simulate the row landing between our select and insert.
          db._store.tapo_devices.push({ id: 'race-1', location_id: LOC, sidecar_device_id: 'homey:race', last_state: 'off' })
          return { code: '23505', message: 'duplicate key' }
        },
      },
    )
    const out = await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:race', state: 'on', reachable: true }])
    expect(out).toEqual({ updated: 1, discovered: 0, failed: 0 })
    expect(db._store.tapo_devices.find((r) => r.id === 'race-1').last_state).toBe('on')
  })

  it('a non-23505 insert error counts as failed', async () => {
    const db = makeDb({}, { insertError: () => ({ code: '23503', message: 'fk violation' }) })
    const out = await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:a', state: 'on', reachable: true }])
    expect(out).toEqual({ updated: 0, discovered: 0, failed: 1 })
  })

  it('an update error on an existing device counts as failed', async () => {
    const db = makeDb(
      { tapo_devices: [{ id: 'd1', location_id: LOC, sidecar_device_id: 'homey:a', last_state: 'off' }] },
      { updateError: () => ({ message: 'write failed' }) },
    )
    const out = await reportDeviceStates(db, LOC, [{ sidecar_device_id: 'homey:a', state: 'on', reachable: true }])
    expect(out).toEqual({ updated: 0, discovered: 0, failed: 1 })
  })

  it('caps at 200 rows, slicing defensively', async () => {
    const db = makeDb()
    const rows = Array.from({ length: 250 }, (_, i) => ({ sidecar_device_id: `homey:${i}`, state: 'on', reachable: true }))
    const out = await reportDeviceStates(db, LOC, rows)
    expect(out.discovered).toBe(200)
    expect(db._store.tapo_devices).toHaveLength(200)
  })
})

// ── runHomeyReconcile ────────────────────────────────────────────

const homeyRaw = {
  'abc-1': {
    id: 'abc-1', name: 'Front TVs', class: 'socket', available: true,
    capabilities: ['onoff'], capabilitiesObj: { onoff: { value: false } },
  },
}

const enabledDevice = {
  location_id: LOC, sidecar_device_id: 'homey:abc-1', enabled: true, schedule_mode: 'fixed',
  fixed_windows: [{ days: [0, 1, 2, 3, 4, 5, 6], on: '00:00', off: '23:59' }],
  class_rule: {}, override: null,
}

// runHomeyReconcile derives `today` from the real dublinTodayStr() (ported
// verbatim from the directives route, uncontrollable via deps — see the
// spec) but `nowMs` from the injectable `now`. So nowMs must land inside
// the ACTUAL Dublin today, not an arbitrary fixed date, or the fixed
// 00:00-23:59 window (attributed to real-today by resolveDayWindows) and
// nowMs disagree on which calendar day they're for.
const NOON_TODAY_MS = dublinDayStartMs(dublinTodayStr()) + 12 * 60 * 60_000

function baseDeps({ getConfig, getDevices, setOnoff } = {}) {
  return {
    getConfig: getConfig || vi.fn(() => ({ url: 'https://x.connect.athom.com', apiKey: 'k', locationId: LOC })),
    getDevices: getDevices || vi.fn(async () => ({ ok: true, statusCode: 200, body: homeyRaw })),
    setOnoff: setOnoff || vi.fn(async () => ({ ok: true, statusCode: 200 })),
    now: () => NOON_TODAY_MS, // noon Dublin today, inside the fixed all-day window
  }
}

describe('runHomeyReconcile', () => {
  it('unconfigured (null) → skipped, no other dep called', async () => {
    const getDevices = vi.fn()
    const setOnoff = vi.fn()
    const db = makeDb()
    const out = await runHomeyReconcile(db, baseDeps({ getConfig: () => null, getDevices, setOnoff }))
    expect(out).toEqual({ skipped: true, reason: 'unconfigured' })
    expect(getDevices).not.toHaveBeenCalled()
    expect(setOnoff).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('misconfigured (error) → skipped + logged, no other dep called', async () => {
    const getDevices = vi.fn()
    const db = makeDb()
    const out = await runHomeyReconcile(db, baseDeps({ getConfig: () => ({ error: 'half-configured' }), getDevices }))
    expect(out).toEqual({ skipped: true, reason: 'misconfigured' })
    expect(getDevices).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('homey-reconcile', 'misconfigured', { error: 'half-configured' })
  })

  it('Homey unreachable → homeyDown, no DB touched', async () => {
    const db = makeDb({ tapo_devices: [enabledDevice] })
    const getDevices = vi.fn(async () => ({ ok: false, statusCode: 401, body: null }))
    const out = await runHomeyReconcile(db, baseDeps({ getDevices }))
    expect(out).toEqual({ ok: true, homeyDown: true })
    expect(db._calls.inserts).toEqual([])
    expect(db._calls.updates).toEqual([])
    expect(logWarn).toHaveBeenCalledWith('homey-reconcile', 'homey unreachable', { statusCode: 401 })
  })

  it('happy path: commands only the mismatched device, reports all devices, counters correct', async () => {
    const db = makeDb({ tapo_devices: [{ id: 'd1', ...enabledDevice }] })
    const setOnoff = vi.fn(async () => ({ ok: true, statusCode: 200 }))
    const out = await runHomeyReconcile(db, baseDeps({ setOnoff }))
    expect(setOnoff).toHaveBeenCalledTimes(1)
    expect(setOnoff).toHaveBeenCalledWith(expect.objectContaining({ locationId: LOC }), 'homey:abc-1', true)
    expect(out).toMatchObject({ ok: true, commanded: 1, commandFailures: 0, updated: 1, discovered: 0, failed: 0 })
    const row = db._store.tapo_devices.find((r) => r.id === 'd1')
    expect(row.last_state).toBe('off') // reported state is the pre-command GET snapshot
  })

  it('command failure: still reports, commandFailures counted', async () => {
    const db = makeDb({ tapo_devices: [{ id: 'd1', ...enabledDevice }] })
    const setOnoff = vi.fn(async () => ({ ok: false, statusCode: 500 }))
    const out = await runHomeyReconcile(db, baseDeps({ setOnoff }))
    expect(out).toMatchObject({ ok: true, commanded: 0, commandFailures: 1, updated: 1 })
    expect(logWarn).toHaveBeenCalledWith('homey-reconcile', 'command failed', { sidecarDeviceId: 'homey:abc-1', statusCode: 500 })
  })

  it('db device-load error → ok:false, no commands fired', async () => {
    const db = makeDb(
      { tapo_devices: [{ id: 'd1', ...enabledDevice }] },
      { selectError: (table, filters) => (table === 'tapo_devices' && filters.some((f) => f[1] === 'enabled') ? { message: 'db down' } : null) },
    )
    const setOnoff = vi.fn()
    const out = await runHomeyReconcile(db, baseDeps({ setOnoff }))
    expect(out).toEqual({ ok: false, error: 'db down' })
    expect(setOnoff).not.toHaveBeenCalled()
  })
})
