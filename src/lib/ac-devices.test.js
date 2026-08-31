// STUDIO-AC-DEVICES.1 dispatcher tests.
//
// The dispatcher centralises the permission gate + vendor dispatch
// + session bookkeeping for every AC operation. A bug in any one
// of those is high-impact (worst case: leaks AC control across
// staff who shouldn't have it, or silently routes a control
// command to the wrong vendor), so we cover the three concerns
// explicitly.
//
// We mock the audit log module and inject fake vendor adapters via
// the ctx.vendorAdapters hook. The DB is mocked per-test with the
// minimal Supabase chain methods the dispatcher uses.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the audit log so it never tries to spin up a real Supabase
// client. We assert on the call args via the spy.
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async () => ({ logged: true })),
}))

import {
  authoriseDevice,
  loadDeviceForUser,
  loadDeviceWithLocation,
  vendorTurnOff,
  findDefaultDeviceForLocation,
  turnOn,
  turnOff,
  extendSession,
  getState,
} from './ac-devices.js'
import { logAuditEvent } from '@/lib/audit'

// ============================================================
// Test fixtures
// ============================================================

const MASTER_USER = { id: 'u-master', role: 'master', profileRole: 'master', full_name: 'M', email: 'm@x' }
const STAFF_USER  = { id: 'u-staff',  role: 'staff',  profileRole: 'staff',  full_name: 'S', email: 's@x' }
const OWNER_USER  = { id: 'u-owner',  role: 'owner',  profileRole: 'owner',  full_name: 'O', email: 'o@x' }
const MANAGER_USER = { id: 'u-mgr',   role: 'manager', profileRole: 'manager', full_name: 'Mg', email: 'mg@x' }

const SENSIBO_DEVICE = {
  id: 'dev-sensibo', location_id: 'loc-1', label: 'Studio Floor',
  provider: 'sensibo', provider_device_id: 'pod-aaa',
  default_mode: 'cool', default_temp_c: 18, default_fan: 'high',
  session_minutes: 90, enabled: true,
}
const THINQ_DEVICE = {
  id: 'dev-thinq', location_id: 'loc-1', label: 'Bathroom M',
  provider: 'thinq', provider_device_id: 'lg-aaa',
  default_mode: 'cool', default_temp_c: 22, default_fan: 'auto',
  session_minutes: 30, enabled: true,
}
const LOCATION_FULL = {
  id: 'loc-1', name: 'Stillorgan',
  sensibo_api_key: 'sens-k', sensibo_pod_id: 'pod-aaa',
  thinq_pat: 'pat-x', thinq_client_id: 'cli-x', thinq_country_code: 'IE',
}

// ============================================================
// DB mock
// ============================================================

function makeQueryMock(result) {
  // Chainable proxy that returns itself for every Supabase builder
  // method we use, and resolves to `result` at the terminal
  // methods (single/maybeSingle/select-after-update/etc.). Also
  // thenable so `await query` works for non-terminal sequences.
  const noop = () => chain
  const terminal = async () => result
  const chain = {
    select: noop, eq: noop, in: noop, order: noop, limit: noop,
    update: noop, insert: noop, delete: noop,
    single: terminal, maybeSingle: terminal,
    then(onF, onR) { return Promise.resolve(result).then(onF, onR) },
  }
  return chain
}

/**
 * @param handlers — { tableName: (callIdx) => mockResult | mockResult }
 *   where mockResult is { data, error? }. If a value is a function,
 *   it receives the 0-based call index and returns the result, which
 *   lets a single table answer different queries (e.g. ac_sessions
 *   queried twice: once for the active-session guard, once for the
 *   insert).
 */
function makeDb(handlers, { onInsert, onUpdate } = {}) {
  const counts = {}
  return {
    from(table) {
      counts[table] = (counts[table] || 0) + 1
      const h = handlers[table]
      let result = typeof h === 'function' ? h(counts[table] - 1) : h
      if (result === undefined) {
        throw new Error(`Test missed mock for table '${table}' call #${counts[table]}`)
      }
      const chain = makeQueryMock(result)
      chain.insert = (row) => { if (onInsert) onInsert(table, row); return chain }
      chain.update = (patch) => { if (onUpdate) onUpdate(table, patch); return chain }
      return chain
    },
  }
}

// Stub vendor adapters with spies so we can assert dispatch.
function makeAdapters() {
  return {
    sensibo: {
      buildTurnOnState: vi.fn(({ mode, temp, fan }) => ({ on: true, mode, targetTemperature: temp, fanLevel: fan })),
      // SENSIBO-RATE.1 — the real adapter exposes this so turnOff can
      // be ONE POST instead of a read-then-write. ThinQ deliberately
      // has no counterpart, so it receives undefined and ignores it.
      buildOffState: vi.fn(({ mode, temp, fan }) => ({ on: false, mode, targetTemperature: temp, fanLevel: fan })),
      setState:  vi.fn(async () => ({ on: true })),
      turnOff:   vi.fn(async () => ({ on: false })),
      getState:  vi.fn(async () => ({ on: true })),
    },
    thinq: {
      buildTurnOnState: vi.fn(({ mode, tempC, fan }) => ({ operation: { airConOperationMode: 'POWER_ON' }, mode, tempC, fan })),
      setState:  vi.fn(async () => ({ on: true })),
      turnOff:   vi.fn(async () => ({ on: false })),
      getState:  vi.fn(async () => ({ on: true, mode: 'cool' })),
    },
  }
}

beforeEach(() => { logAuditEvent.mockClear() })

// ============================================================
// authoriseDevice — pure function
// ============================================================

describe('authoriseDevice', () => {
  it('allows master regardless of assignment / allowlist', () => {
    expect(authoriseDevice({ user: MASTER_USER, assignment: null, deviceId: 'd1' }))
      .toMatchObject({ ok: true, role: 'master' })
    expect(authoriseDevice({ user: MASTER_USER, assignment: { ac_device_ids: [] }, deviceId: 'd1' }))
      .toMatchObject({ ok: true, role: 'master' })
  })

  it('denies a user with no profile_locations row at the device location', () => {
    expect(authoriseDevice({ user: STAFF_USER, assignment: null, deviceId: 'd1' }))
      .toMatchObject({ ok: false, status: 403, code: 'not_assigned_to_location' })
  })

  it('allows when the device id is in the assignment allowlist', () => {
    expect(authoriseDevice({
      user: STAFF_USER,
      assignment: { role: 'staff', ac_device_ids: ['d1', 'd2'] },
      deviceId: 'd1',
    })).toMatchObject({ ok: true })
  })

  it('denies when the allowlist exists but does not include this device', () => {
    expect(authoriseDevice({
      user: STAFF_USER,
      assignment: { role: 'staff', ac_device_ids: ['d2'] },
      deviceId: 'd1',
    })).toMatchObject({ ok: false, status: 403, code: 'device_not_in_allowlist' })
  })

  it('denies when the allowlist is empty (strict opt-in, set by migration 210 backfill)', () => {
    expect(authoriseDevice({
      user: STAFF_USER,
      assignment: { role: 'staff', ac_device_ids: [] },
      deviceId: 'd1',
    })).toMatchObject({ ok: false, status: 403, code: 'device_not_in_allowlist' })
  })

  it('allows NULL allowlist for owner role (legacy fallback)', () => {
    expect(authoriseDevice({
      user: OWNER_USER,
      assignment: { role: 'owner', ac_device_ids: null },
      deviceId: 'd1',
    })).toMatchObject({ ok: true, role: 'owner' })
  })

  it('allows NULL allowlist for manager role (legacy fallback)', () => {
    expect(authoriseDevice({
      user: MANAGER_USER,
      assignment: { role: 'manager', ac_device_ids: null },
      deviceId: 'd1',
    })).toMatchObject({ ok: true, role: 'manager' })
  })

  it('does NOT grant legacy unrestricted access to staff/head_coach/contractor even if allowlist is NULL', () => {
    // Migration 210 backfills these roles with '{}' not NULL, but
    // belt-and-braces: if any post-migration row ends up NULL for
    // them, we should still deny rather than grant access.
    expect(authoriseDevice({
      user: STAFF_USER,
      assignment: { role: 'staff', ac_device_ids: null },
      deviceId: 'd1',
    })).toMatchObject({ ok: false, status: 403 })
  })

  it('respects per-location role override (assignment.role > user.profileRole)', () => {
    // User's global role is 'staff' but their per-location role is
    // 'manager' — they get the legacy NULL allowance.
    expect(authoriseDevice({
      user: STAFF_USER,
      assignment: { role: 'manager', ac_device_ids: null },
      deviceId: 'd1',
    })).toMatchObject({ ok: true, role: 'manager' })
  })
})

// ============================================================
// loadDeviceForUser
// ============================================================

describe('loadDeviceForUser', () => {
  it('returns 400 when deviceId is missing', async () => {
    const db = makeDb({})
    expect(await loadDeviceForUser('', { user: MASTER_USER, db }))
      .toMatchObject({ ok: false, status: 400, code: 'missing_device_id' })
  })

  it('returns 404 when device row does not exist', async () => {
    const db = makeDb({ ac_devices: { data: null } })
    expect(await loadDeviceForUser('dev-x', { user: MASTER_USER, db }))
      .toMatchObject({ ok: false, status: 404, code: 'device_not_found' })
  })

  it('returns 409 when device is disabled', async () => {
    const db = makeDb({
      ac_devices: { data: { ...SENSIBO_DEVICE, enabled: false } },
    })
    expect(await loadDeviceForUser('dev-x', { user: MASTER_USER, db }))
      .toMatchObject({ ok: false, status: 409, code: 'device_disabled' })
  })

  it('returns 404 when the device location row is missing', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: null },
      profile_locations: { data: null },
    })
    expect(await loadDeviceForUser('dev-x', { user: MASTER_USER, db }))
      .toMatchObject({ ok: false, status: 404, code: 'location_not_found' })
  })

  it('returns the device + location when master + everything resolves', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: null },
    })
    const out = await loadDeviceForUser('dev-x', { user: MASTER_USER, db })
    expect(out.ok).toBe(true)
    expect(out.device.id).toBe('dev-sensibo')
    expect(out.location.id).toBe('loc-1')
  })

  it('denies a staff user not in the allowlist', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'staff', ac_device_ids: [] } },
    })
    expect(await loadDeviceForUser('dev-x', { user: STAFF_USER, db }))
      .toMatchObject({ ok: false, status: 403 })
  })
})

// ============================================================
// turnOn — happy path + edge cases
// ============================================================

describe('turnOn', () => {
  it('happy path: vendor accepts → session inserted → audit logged', async () => {
    const inserts = []
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       (i) => {
        // First call is the active-session guard (empty), second
        // call is the insert (returns the inserted row).
        if (i === 0) return { data: [] }
        return { data: { id: 'sess-1', status: 'on', location_id: 'loc-1' } }
      },
    }, { onInsert: (t, row) => inserts.push([t, row]) })

    const vendorAdapters = makeAdapters()
    const out = await turnOn('dev-sensibo', {
      user: MASTER_USER, db, vendorAdapters,
    })
    expect(out.ok).toBe(true)
    expect(out.session.id).toBe('sess-1')

    expect(vendorAdapters.sensibo.setState).toHaveBeenCalledTimes(1)
    expect(vendorAdapters.thinq.setState).not.toHaveBeenCalled()

    // sensibo_pod_id is populated for Sensibo devices so legacy
    // state route reads still work during the transition.
    expect(inserts[0][1]).toMatchObject({
      device_id: 'dev-sensibo',
      sensibo_pod_id: 'pod-aaa',
      started_by: 'u-master',
      status: 'on',
    })

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      category: 'business',
      action: 'ac.turn_on',
      actor: expect.objectContaining({ id: 'u-master' }),
      target: expect.objectContaining({ label: 'Studio Floor', resource: 'ac_device/dev-sensibo' }),
      locationId: 'loc-1',
    }))
    // Device ids are NOT profiles ids — a target.id here lands in
    // audit_events.target_profile_id, violates its FK to profiles and the
    // whole audit row is silently dropped. Device identity rides in
    // target.resource only.
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })

  it('thinq device: dispatches to thinq adapter and leaves sensibo_pod_id NULL', async () => {
    const inserts = []
    const db = makeDb({
      ac_devices:        { data: THINQ_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       (i) => i === 0 ? { data: [] } : { data: { id: 'sess-2' } },
    }, { onInsert: (t, row) => inserts.push([t, row]) })

    const vendorAdapters = makeAdapters()
    const out = await turnOn('dev-thinq', { user: MASTER_USER, db, vendorAdapters })
    expect(out.ok).toBe(true)
    expect(vendorAdapters.thinq.setState).toHaveBeenCalledTimes(1)
    expect(vendorAdapters.sensibo.setState).not.toHaveBeenCalled()
    expect(inserts[0][1]).toMatchObject({
      device_id: 'dev-thinq',
      sensibo_pod_id: null,   // not populated for ThinQ
    })
  })

  it('returns 409 with existing session when one is already active', async () => {
    const existing = {
      id: 'sess-old', started_at: new Date(Date.now() - 60_000).toISOString(),
      auto_off_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      status: 'on', started_by: 'u-other',
      profiles: { full_name: 'Other Staffer' },
    }
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       { data: [existing] },
    })

    const vendorAdapters = makeAdapters()
    const out = await turnOn('dev-sensibo', { user: MASTER_USER, db, vendorAdapters })
    expect(out).toMatchObject({ ok: false, status: 409, code: 'already_running' })
    expect(out.session).toEqual(existing)
    expect(out.error).toMatch(/already on/i)
    expect(out.error).toMatch(/Other Staffer/)
    expect(out.error).toMatch(/30 min/)
    // Vendor never gets called when we short-circuit on the guard.
    expect(vendorAdapters.sensibo.setState).not.toHaveBeenCalled()
  })

  it('returns 502 when the vendor refuses the turn-on', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       { data: [] },
    })
    const vendorAdapters = makeAdapters()
    vendorAdapters.sensibo.setState.mockRejectedValueOnce(new Error('Pod offline'))

    const out = await turnOn('dev-sensibo', { user: MASTER_USER, db, vendorAdapters })
    expect(out).toMatchObject({ ok: false, status: 502, code: 'vendor_error' })
    expect(out.error).toMatch(/Pod offline/)
  })

  it('returns 412 when Sensibo credentials are missing on the location', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: { ...LOCATION_FULL, sensibo_api_key: null } },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      // The already-running guard runs before the credentials
      // resolution; mock the empty-sessions result so we get
      // through to the credentials check.
      ac_sessions:       { data: [] },
    })
    const out = await turnOn('dev-sensibo', { user: MASTER_USER, db, vendorAdapters: makeAdapters() })
    expect(out).toMatchObject({ ok: false, status: 412, code: 'sensibo_not_configured' })
  })

  it('returns 412 when ThinQ credentials are missing on the location', async () => {
    const db = makeDb({
      ac_devices:        { data: THINQ_DEVICE },
      locations:         { data: { ...LOCATION_FULL, thinq_pat: null } },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       { data: [] },
    })
    const out = await turnOn('dev-thinq', { user: MASTER_USER, db, vendorAdapters: makeAdapters() })
    expect(out).toMatchObject({ ok: false, status: 412, code: 'thinq_not_configured' })
  })

  it('per-device defaults are passed to the vendor adapter', async () => {
    const db = makeDb({
      ac_devices:        { data: { ...THINQ_DEVICE, default_mode: 'heat', default_temp_c: 24, default_fan: 'low' } },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       (i) => i === 0 ? { data: [] } : { data: { id: 'sess-3' } },
    })
    const vendorAdapters = makeAdapters()
    await turnOn('dev-thinq', { user: MASTER_USER, db, vendorAdapters })
    expect(vendorAdapters.thinq.buildTurnOnState).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'heat', tempC: 24, fan: 'low' })
    )
  })
})

// ============================================================
// turnOff
// ============================================================

describe('turnOff', () => {
  it('happy path: vendor power-off + sessions closed + audit logged', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       { data: [{ id: 'sess-1' }] },
    })
    const vendorAdapters = makeAdapters()
    const out = await turnOff('dev-sensibo', { user: MASTER_USER, db, vendorAdapters })
    expect(out.ok).toBe(true)
    expect(out.sessions_closed).toBe(1)
    expect(vendorAdapters.sensibo.turnOff).toHaveBeenCalledWith(
      'pod-aaa', { apiKey: 'sens-k' },
      { on: false, mode: 'cool', targetTemperature: 18, fanLevel: 'high' })
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ac.turn_off',
      target: expect.objectContaining({ label: 'Studio Floor', resource: 'ac_device/dev-sensibo' }),
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })

  it('returns 502 when vendor refuses (no session updates either)', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
    })
    const vendorAdapters = makeAdapters()
    vendorAdapters.sensibo.turnOff.mockRejectedValueOnce(new Error('LG cloud is unreachable'))
    const out = await turnOff('dev-sensibo', { user: MASTER_USER, db, vendorAdapters })
    expect(out).toMatchObject({ ok: false, status: 502 })
  })
})

// ============================================================
// extendSession
// ============================================================

describe('extendSession', () => {
  it('returns 409 when no session is active', async () => {
    const db = makeDb({
      ac_devices:        { data: THINQ_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       { data: [] },
    })
    expect(await extendSession('dev-thinq', { user: MASTER_USER, db, vendorAdapters: makeAdapters() }))
      .toMatchObject({ ok: false, status: 409, code: 'no_active_session' })
  })

  it('bumps auto_off_at from the existing future time + audit logs', async () => {
    const futureIso = new Date(Date.now() + 5 * 60_000).toISOString()
    const updates = []
    const db = makeDb({
      ac_devices:        { data: { ...THINQ_DEVICE, session_minutes: 30 } },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
      ac_sessions:       (i) => {
        if (i === 0) return { data: [{ id: 'sess-1', auto_off_at: futureIso, status: 'on' }] }
        return { data: { id: 'sess-1', status: 'extended', auto_off_at: 'updated' } }
      },
    }, { onUpdate: (t, patch) => updates.push([t, patch]) })

    const out = await extendSession('dev-thinq', { user: MASTER_USER, db, vendorAdapters: makeAdapters() })
    expect(out.ok).toBe(true)
    expect(updates[0][0]).toBe('ac_sessions')
    expect(updates[0][1].status).toBe('extended')
    // The new auto_off_at should be > existing future time + 25 min
    // (within sensible margin of session_minutes = 30 added from a
    // base of 5 min in the future).
    const newTime = new Date(updates[0][1].auto_off_at).getTime()
    const baseTime = new Date(futureIso).getTime()
    expect(newTime - baseTime).toBeGreaterThan(25 * 60_000)
    expect(newTime - baseTime).toBeLessThan(35 * 60_000)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ac.extend',
      target: expect.objectContaining({ label: 'Bathroom M', resource: 'ac_device/dev-thinq' }),
    }))
    expect(logAuditEvent.mock.calls.at(-1)[0].target.id).toBeUndefined()
  })
})

// ============================================================
// getState — vendor dispatch
// ============================================================

// ============================================================
// Cron helpers (loadDeviceWithLocation, vendorTurnOff,
// findDefaultDeviceForLocation)
// ============================================================

describe('loadDeviceWithLocation', () => {
  it('returns 400 when deviceId is missing', async () => {
    expect(await loadDeviceWithLocation('', { from: () => {} }))
      .toMatchObject({ ok: false, status: 400, code: 'missing_device_id' })
  })

  it('returns 404 when device row does not exist (no permission check)', async () => {
    const db = makeDb({ ac_devices: { data: null } })
    expect(await loadDeviceWithLocation('dev-x', db))
      .toMatchObject({ ok: false, status: 404, code: 'device_not_found' })
  })

  it('returns device + location and skips the user/allowlist gate', async () => {
    // No profile_locations mock — proves the cron path does not
    // call the permission gate. If it did, makeDb would throw on
    // the missing mock.
    const db = makeDb({
      ac_devices: { data: THINQ_DEVICE },
      locations:  { data: LOCATION_FULL },
    })
    const out = await loadDeviceWithLocation('dev-thinq', db)
    expect(out.ok).toBe(true)
    expect(out.device.id).toBe('dev-thinq')
    expect(out.location.id).toBe('loc-1')
  })
})

describe('vendorTurnOff', () => {
  it('dispatches to the right vendor adapter (no DB, no permission, no audit)', async () => {
    const vendorAdapters = makeAdapters()
    const out = await vendorTurnOff(THINQ_DEVICE, LOCATION_FULL, { vendorAdapters })
    expect(out.ok).toBe(true)
    // Third arg is the desired off state — undefined for ThinQ, which
    // exposes no buildOffState because its power-off is already one call.
    expect(vendorAdapters.thinq.turnOff).toHaveBeenCalledWith('lg-aaa', {
      pat: 'pat-x', clientId: 'cli-x', countryCode: 'IE',
    }, undefined)
    expect(vendorAdapters.sensibo.turnOff).not.toHaveBeenCalled()
    // No audit row for cron-initiated turn-offs.
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('surfaces vendor errors as 502 vendor_error', async () => {
    const vendorAdapters = makeAdapters()
    vendorAdapters.sensibo.turnOff.mockRejectedValueOnce(new Error('Pod is offline'))
    const out = await vendorTurnOff(SENSIBO_DEVICE, LOCATION_FULL, { vendorAdapters })
    expect(out).toMatchObject({ ok: false, status: 502, code: 'vendor_error' })
    expect(out.error).toMatch(/Pod is offline/)
  })

  it('returns 412 when credentials are missing on the location', async () => {
    const out = await vendorTurnOff(
      THINQ_DEVICE,
      { ...LOCATION_FULL, thinq_pat: null },
      { vendorAdapters: makeAdapters() }
    )
    expect(out).toMatchObject({ ok: false, status: 412, code: 'thinq_not_configured' })
  })
})

describe('findDefaultDeviceForLocation', () => {
  it('returns the first enabled device at the location', async () => {
    const db = makeDb({ ac_devices: { data: SENSIBO_DEVICE } })
    expect(await findDefaultDeviceForLocation('loc-1', db))
      .toMatchObject({ id: 'dev-sensibo' })
  })

  it('returns null when there are no enabled devices', async () => {
    const db = makeDb({ ac_devices: { data: null } })
    expect(await findDefaultDeviceForLocation('loc-1', db)).toBeNull()
  })

  it('returns null when locationId is missing', async () => {
    expect(await findDefaultDeviceForLocation(null, {})).toBeNull()
  })
})

describe('getState', () => {
  it('dispatches to the right vendor based on device.provider', async () => {
    const db = makeDb({
      ac_devices:        { data: THINQ_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
    })
    const vendorAdapters = makeAdapters()
    const out = await getState('dev-thinq', { user: MASTER_USER, db, vendorAdapters })
    expect(out.ok).toBe(true)
    expect(vendorAdapters.thinq.getState).toHaveBeenCalledWith('lg-aaa', {
      pat: 'pat-x', clientId: 'cli-x', countryCode: 'IE',
    })
    expect(vendorAdapters.sensibo.getState).not.toHaveBeenCalled()
  })

  it('surfaces vendor errors as 502 vendor_error', async () => {
    const db = makeDb({
      ac_devices:        { data: SENSIBO_DEVICE },
      locations:         { data: LOCATION_FULL },
      profile_locations: { data: { role: 'master', ac_device_ids: null } },
    })
    const vendorAdapters = makeAdapters()
    vendorAdapters.sensibo.getState.mockRejectedValueOnce(new Error('boom'))
    const out = await getState('dev-sensibo', { user: MASTER_USER, db, vendorAdapters })
    expect(out).toMatchObject({ ok: false, status: 502, code: 'vendor_error' })
  })
})

describe('authoriseDevice with role-template fallback (AC-ROLE.1)', () => {
  const user = { id: 'u1', role: 'staff' }
  it('staff with null per-user list falls to the role template', () => {
    const a = { role: 'staff', ac_device_ids: null }
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd1', templateList: ['d1'] }).ok).toBe(true)
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd2', templateList: ['d1'] }).ok).toBe(false)
  })
  it('per-user explicit list overrides the template', () => {
    const a = { role: 'staff', ac_device_ids: ['d2'] }
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd2', templateList: ['d1'] }).ok).toBe(true)
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd1', templateList: ['d1'] }).ok).toBe(false)
  })
  it('staff with null list and no template resolves to none (code default)', () => {
    const a = { role: 'staff', ac_device_ids: null }
    expect(authoriseDevice({ user, assignment: a, deviceId: 'd1', templateList: null }).ok).toBe(false)
  })
  it('manager with null list and no template still gets all (code default)', () => {
    const mgr = { id: 'm', role: 'manager' }
    const a = { role: 'manager', ac_device_ids: null }
    expect(authoriseDevice({ user: mgr, assignment: a, deviceId: 'anything', templateList: null }).ok).toBe(true)
  })
  it('master is always allowed', () => {
    expect(authoriseDevice({ user: { role: 'master' }, assignment: null, deviceId: 'd', templateList: null }).ok).toBe(true)
  })
})
