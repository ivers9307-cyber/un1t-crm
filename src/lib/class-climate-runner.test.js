// CLASS-CLIMATE.1 (P0-8) — unit tests for the class-climate runtime and the
// spine's cancellation reconciliation. The runner touches the AC vendor, so
// the vendor + device loader + audit are mocked and a lightweight in-memory
// Supabase fake stands in for the DB. The fake honours the filters the code
// relies on (notably `.is('cancelled_at', null)`) so a cancelled occurrence is
// genuinely excluded rather than assumed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(() => Promise.resolve()) }))

const vendorTurnOn = vi.fn()
const loadDeviceWithLocation = vi.fn()
vi.mock('@/lib/ac-devices', () => ({
  vendorTurnOn: (...a) => vendorTurnOn(...a),
  loadDeviceWithLocation: (...a) => loadDeviceWithLocation(...a),
}))

const fetchUpcomingEvents = vi.fn()
vi.mock('@/lib/glofox', () => ({
  fetchUpcomingEvents: (...a) => fetchUpcomingEvents(...a),
}))

import { runClassClimateForLocation } from './class-climate-runner.js'
import { syncOccurrencesForLocation } from './class-occurrences.js'
import { logAuditEvent } from '@/lib/audit'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-06-18T05:40:00.000Z') // 10 min before a 05:50 class start

// ── in-memory Supabase fake ────────────────────────────────────────
// Tables are arrays of plain rows. A query builder collects filters, then
// resolves to { data, error } applying eq / gte / lte / in / is filters.
// Terminal ops: select (awaitable), insert, update (awaitable), upsert.
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
  return { from: (t) => builder(t), _store: store, _calls: calls }
}

function occ(id, { startOffsetMin = 10, durMin = 45, cancelled_at = null } = {}) {
  const start = NOW + startOffsetMin * 60_000
  return {
    glofox_event_id: id,
    location_id: LOC,
    name: 'Strength 45',
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + durMin * 60_000).toISOString(),
    cancelled_at,
  }
}

const CONFIG = { device_ids: ['dev1'], offset_on_min: 15, offset_off_min: 5, class_filter: [], excluded_slots: [] }

beforeEach(() => {
  vendorTurnOn.mockReset()
  loadDeviceWithLocation.mockReset()
  fetchUpcomingEvents.mockReset()
  logAuditEvent.mockClear()
  loadDeviceWithLocation.mockResolvedValue({
    ok: true,
    device: { id: 'dev1', label: 'Studio AC', provider: 'sensibo', provider_device_id: 'pod1' },
    location: { id: LOC },
  })
  vendorTurnOn.mockResolvedValue({ ok: true, observed: {} })
})

// ── runner: firing behaviour ───────────────────────────────────────

describe('runClassClimateForLocation', () => {
  it('fires ON for a live, un-cancelled occurrence', async () => {
    const db = makeDb({ class_occurrences: [occ('evt1')] })
    const out = await runClassClimateForLocation(db, { location_id: LOC, config: CONFIG }, { nowMs: NOW })
    expect(out.actions.map((a) => a.status)).toEqual(['fired'])
    expect(vendorTurnOn).toHaveBeenCalledTimes(1)
    // an ac_sessions row was written for the fire
    expect(db._store.ac_sessions).toHaveLength(1)
  })

  it('audits the fire with a device resource target and no target.id (system action → target_profile_id NULL)', async () => {
    const db = makeDb({ class_occurrences: [occ('evt1')] })
    await runClassClimateForLocation(db, { location_id: LOC, config: CONFIG }, { nowMs: NOW })
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    const audit = logAuditEvent.mock.calls[0][0]
    expect(audit.action).toBe('ac.class_auto_on')
    expect(audit.target.label).toBe('Studio AC')
    expect(audit.target.resource).toBe('ac_device/dev1')
    // Device ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id, violates its FK to profiles and the
    // whole audit row is silently dropped (every automated fire was lost).
    expect(audit.target.id).toBeUndefined()
  })

  it('does NOT fire on a cancelled_at-flagged occurrence (P0-8 core fix)', async () => {
    const db = makeDb({ class_occurrences: [occ('evt1', { cancelled_at: '2026-06-18T05:00:00.000Z' })] })
    const out = await runClassClimateForLocation(db, { location_id: LOC, config: CONFIG }, { nowMs: NOW })
    expect(out.planned).toEqual([])
    expect(out.actions).toEqual([])
    expect(vendorTurnOn).not.toHaveBeenCalled()
    expect(db._store.ac_sessions).toHaveLength(0)
  })

  it('skips when the AC is already on (already-on skip)', async () => {
    const db = makeDb({
      class_occurrences: [occ('evt1')],
      ac_sessions: [{ id: 's1', device_id: 'dev1', status: 'on' }],
    })
    const out = await runClassClimateForLocation(db, { location_id: LOC, config: CONFIG }, { nowMs: NOW })
    expect(out.actions.map((a) => a.status)).toEqual(['skipped'])
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })

  it('is idempotent — a prior fired fire-log row blocks a re-fire', async () => {
    const db = makeDb({
      class_occurrences: [occ('evt1')],
      automation_fire_log: [
        { automation_key: 'class_climate', action_step: 'on', glofox_event_id: 'evt1', device_id: 'dev1', status: 'fired' },
      ],
    })
    const out = await runClassClimateForLocation(db, { location_id: LOC, config: CONFIG }, { nowMs: NOW })
    expect(out.actions).toEqual([]) // firedSet short-circuits before any vendor call
    expect(vendorTurnOn).not.toHaveBeenCalled()
  })
})

// ── spine reconciliation ───────────────────────────────────────────

describe('syncOccurrencesForLocation: cancellation reconciliation', () => {
  const creds = { branch_id: 'b', api_key: 'k', api_token: 't' }
  const glofoxEvent = (id, startOffsetMin = 60) => ({
    _id: id,
    name: 'Strength 45',
    time_start: Math.floor((NOW + startOffsetMin * 60_000) / 1000),
    duration: 45,
    active: true,
  })

  it('stamps cancelled_at on a previously-synced event now absent from the fetch', async () => {
    // evt-gone was synced before and sits inside the window; the fetch only
    // returns evt-live now → evt-gone must be cancelled.
    const db = makeDb({
      class_occurrences: [
        occ('evt-live', { startOffsetMin: 60 }),
        occ('evt-gone', { startOffsetMin: 90 }),
      ],
    })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt-live', 60)] })

    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out.ok).toBe(true)
    expect(out.cancelled).toBe(1)
    const gone = db._store.class_occurrences.find((r) => r.glofox_event_id === 'evt-gone')
    const live = db._store.class_occurrences.find((r) => r.glofox_event_id === 'evt-live')
    expect(gone.cancelled_at).not.toBeNull()
    expect(live.cancelled_at).toBeNull()
  })

  it('does NOT cancel private events — they still run', async () => {
    const db = makeDb({
      class_occurrences: [occ('evt-priv', { startOffsetMin: 60 })],
    })
    // Private event comes back active:true but private:true → seen, not upserted, not cancelled.
    fetchUpcomingEvents.mockResolvedValue({
      ok: true,
      events: [{ ...glofoxEvent('evt-priv', 60), private: true }],
    })
    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out.cancelled).toBe(0)
    expect(db._store.class_occurrences.find((r) => r.glofox_event_id === 'evt-priv').cancelled_at).toBeNull()
  })

  it('CRITICAL GUARD: a FAILED fetch cancels nothing', async () => {
    const db = makeDb({ class_occurrences: [occ('evt-a', { startOffsetMin: 60 })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: false, status: 502, body: { message: 'bad gateway' } })

    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out.ok).toBe(false)
    expect(db._store.class_occurrences[0].cancelled_at).toBeNull()
  })

  it('CRITICAL GUARD: a zero-event fetch (Glofox blip) cancels nothing', async () => {
    const db = makeDb({ class_occurrences: [occ('evt-a', { startOffsetMin: 60 })] })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [] })

    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out.ok).toBe(true)
    expect(out.cancelled).toBe(0)
    expect(db._store.class_occurrences[0].cancelled_at).toBeNull()
  })

  it('un-cancels a reinstated class (cancelled_at → null on re-upsert)', async () => {
    const db = makeDb({
      class_occurrences: [occ('evt-back', { startOffsetMin: 60, cancelled_at: '2026-06-17T00:00:00.000Z' })],
    })
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [glofoxEvent('evt-back', 60)] })

    const out = await syncOccurrencesForLocation(db, { locationId: LOC, creds, nowMs: NOW })
    expect(out.ok).toBe(true)
    // upsert payload carried cancelled_at: null
    const upsertRows = db._calls.upserts.flatMap((u) => u.rows)
    const row = upsertRows.find((r) => r.glofox_event_id === 'evt-back')
    expect(row.cancelled_at).toBeNull()
  })
})
