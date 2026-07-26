// BATHROOM-CLIMATE.1 — unit tests for the bathroom-climate runtime. The
// runner touches the AC vendor, so the vendor + device loader + audit are
// mocked and a lightweight in-memory Supabase fake stands in for the DB.
// Copied verbatim from class-climate-runner.test.js's mock preamble +
// makeDb (the @/lib/glofox mock and syncOccurrencesForLocation import are
// not needed here — this file only tests the runner, not the spine sync).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(() => Promise.resolve()) }))

const vendorTurnOn = vi.fn()
const loadDeviceWithLocation = vi.fn()
vi.mock('@/lib/ac-devices', () => ({
  vendorTurnOn: (...a) => vendorTurnOn(...a),
  loadDeviceWithLocation: (...a) => loadDeviceWithLocation(...a),
}))

import { runBathroomClimateForLocation } from './bathroom-climate-runner.js'
import { logAuditEvent } from '@/lib/audit'

// ── in-memory Supabase fake ────────────────────────────────────────
// Tables are arrays of plain rows. A query builder collects filters, then
// resolves to { data, error } applying eq / gte / lte / in / is filters.
// Terminal ops: select (awaitable), insert, update (awaitable), upsert.
// Extended beyond the class-climate original to also expose `calls` on
// the returned db object (in addition to `_calls`) — the plan's tests
// assert directly on `db.calls.inserts` / `db.calls.upserts`.
function makeDb(tables = {}) {
  const store = {
    class_occurrences: [],
    automation_fire_log: [],
    ac_sessions: [],
    ...tables,
  }
  const calls = { upserts: [], updates: [], inserts: [] }

  function builder(table) {
    const filters = []
    let op = 'select'
    let payload = null
    const applyFilters = (rows) =>
      rows.filter((r) =>
        filters.every(([kind, col, val]) => {
          if (kind === 'eq') return r[col] === val
          if (kind === 'gte') return r[col] != null && r[col] >= val
          if (kind === 'lte') return r[col] != null && r[col] <= val
          if (kind === 'in') return val.includes(r[col])
          if (kind === 'is') return val === null ? r[col] == null : r[col] === val
          return true
        }),
      )
    const chain = {
      select() { return chain },
      eq(col, val) { filters.push(['eq', col, val]); return chain },
      gte(col, val) { filters.push(['gte', col, val]); return chain },
      lte(col, val) { filters.push(['lte', col, val]); return chain },
      in(col, val) { filters.push(['in', col, val]); return chain },
      is(col, val) { filters.push(['is', col, val]); return chain },
      order() { return chain },
      limit() { return chain },
      insert(rows) { op = 'insert'; payload = rows; calls.inserts.push({ table, rows }); return chain },
      update(patch) { op = 'update'; payload = patch; return chain },
      upsert(rows, options) { op = 'upsert'; payload = { rows, options }; calls.upserts.push({ table, rows, options }); return chain },
      then(resolve) {
        if (op === 'update') {
          const matched = applyFilters(store[table])
          for (const r of matched) Object.assign(r, payload)
          calls.updates.push({ table, patch: payload, matched: matched.length })
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        if (op === 'insert') {
          const rows = Array.isArray(payload) ? payload : [payload]
          store[table].push(...rows)
          return Promise.resolve({ data: rows, error: null }).then(resolve)
        }
        if (op === 'upsert') {
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: applyFilters(store[table]), error: null }).then(resolve)
      },
    }
    return chain
  }
  return { from: (t) => builder(t), _store: store, _calls: calls, calls }
}

const LOC = 'a0000000-0000-0000-0000-000000000001'
// Class starts 10:00Z; delay 45 → window 10:45–11:15Z. NOW is inside it.
const NOW = Date.parse('2026-07-27T10:50:00.000Z')
const OCC = {
  location_id: LOC, glofox_event_id: 'ev1', name: 'DR1VE',
  starts_at: '2026-07-27T10:00:00.000Z', ends_at: '2026-07-27T10:50:00.000Z', cancelled_at: null,
}
const ROW = { location_id: LOC, config: { device_ids: ['dev1'], delay_after_start_min: 45, run_duration_min: 30 } }

beforeEach(() => {
  vi.clearAllMocks()
  loadDeviceWithLocation.mockResolvedValue({
    ok: true,
    device: { id: 'dev1', label: 'Bathroom M', provider: 'thinq', provider_device_id: 'lg-1' },
    location: { id: LOC },
  })
  vendorTurnOn.mockResolvedValue({ ok: true, observed: { power: 'on' } })
})

describe('runBathroomClimateForLocation', () => {
  it('errors when no devices configured', async () => {
    const db = makeDb()
    const out = await runBathroomClimateForLocation(db, { location_id: LOC, config: {} }, { nowMs: NOW })
    expect(out.errors).toContain('no_devices_configured')
  })

  it('fires ON inside the window: vendor call + system ac_sessions row + fired log + audit', async () => {
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ glofox_event_id: 'ev1', device_id: 'dev1', status: 'fired' })])
    expect(vendorTurnOn).toHaveBeenCalledTimes(1)
    const session = db.calls.inserts.find((c) => c.table === 'ac_sessions').rows
    expect(session.started_by).toBeNull()
    expect(session.device_id).toBe('dev1')
    // Anchored off: 10:00 + 45 + 30 = 11:15Z regardless of the 10:50 tick.
    expect(session.auto_off_at).toBe('2026-07-27T11:15:00.000Z')
    const fire = db.calls.upserts.find((c) => c.table === 'automation_fire_log').rows
    expect(fire.automation_key).toBe('bathroom_climate')
    expect(fire.status).toBe('fired')
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ac.bathroom_auto_on' }))
  })

  it('does nothing before the window opens', async () => {
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: Date.parse('2026-07-27T10:30:00.000Z') })
    expect(out.planned).toEqual([])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('skips a cancelled class (the .is cancelled_at filter)', async () => {
    const db = makeDb({ class_occurrences: [{ ...OCC, cancelled_at: '2026-07-27T08:00:00.000Z' }] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.planned).toEqual([])
  })

  it('is idempotent — an existing fired log row blocks a re-fire', async () => {
    const db = makeDb({
      class_occurrences: [OCC],
      automation_fire_log: [{ automation_key: 'bathroom_climate', glofox_event_id: 'ev1', device_id: 'dev1', action_step: 'on', status: 'fired' }],
    })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('records skipped (and no vendor call) when the device already has an active session', async () => {
    const db = makeDb({
      class_occurrences: [OCC],
      ac_sessions: [{ id: 's1', device_id: 'dev1', status: 'on' }],
    })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'skipped' })])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('records failed on vendor error and surfaces it', async () => {
    vendorTurnOn.mockResolvedValue({ ok: false, error: 'device offline (1209)' })
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'failed', error: 'device offline (1209)' })])
  })

  it('dry run plans + reports would_fire without touching vendor or DB writes', async () => {
    const db = makeDb({ class_occurrences: [OCC] })
    const out = await runBathroomClimateForLocation(db, ROW, { nowMs: NOW, dryRun: true })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'would_fire' })])
    expect(vendorTurnOn).not.toHaveBeenCalled()
    expect(db.calls.inserts).toEqual([])
  })

  it('2h lookback catches a late window (class started 100 min ago, delay 90)', async () => {
    const row = { location_id: LOC, config: { device_ids: ['dev1'], delay_after_start_min: 90, run_duration_min: 30 } }
    const db = makeDb({ class_occurrences: [{ ...OCC, starts_at: '2026-07-27T09:10:00.000Z' }] })
    // now 10:50 → window 10:40–11:10, class start 100 min back (inside 2h lookback).
    const out = await runBathroomClimateForLocation(db, row, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'fired' })])
  })

  it('derived lookback catches an oversized delay (class started 160 min ago, delay 150)', async () => {
    // delay 150 + duration 30 puts the window at start+150..start+180. A
    // fixed 2h lookback would exclude this class from the occurrence query
    // entirely (starts_at is 160 min before NOW), so the automation would
    // silently never fire — the lookback must be derived from the config.
    const row = { location_id: LOC, config: { device_ids: ['dev1'], delay_after_start_min: 150, run_duration_min: 30 } }
    const db = makeDb({ class_occurrences: [{ ...OCC, starts_at: '2026-07-27T08:10:00.000Z' }] })
    // now 10:50 → class started 160 min back; window 10:40–11:10, NOW is inside it.
    const out = await runBathroomClimateForLocation(db, row, { nowMs: NOW })
    expect(out.actions).toEqual([expect.objectContaining({ status: 'fired' })])
  })
})
