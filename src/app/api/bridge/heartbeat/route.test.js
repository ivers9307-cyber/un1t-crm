// Route tests for POST /api/bridge/heartbeat (BRIDGE-BLIND.1).
//
// WHAT WENT WRONG, 2026-08-12
// The Stillorgan bridge heartbeated healthily for 2.5 hours while ingesting
// zero samples across two full classes. It was SAYING so on every heartbeat —
// `adapters.ble.powered_on: false`, because noble had come up `unauthorized` —
// and this route persisted last_seen_at / status / software_version and threw
// the rest away. Nothing downstream could alert on a signal that was never
// stored.
//
// The two things these tests hold down:
//   1. the telemetry actually lands, in the shape the bridge actually sends;
//   2. nothing about the heartbeat's existing contract moves. A bridge that
//      cannot heartbeat looks OFFLINE, so a telemetry bug that failed the
//      request would convert a logging gap into a fake fleet outage.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-auth', () => ({ verifyBridgeToken: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyBridgeToken } from '@/lib/bridge-auth'

const BRIDGE_ID = '9acc6318-0d73-4bbc-bd4d-c98b0f613179'

/** Captures the single .update() payload the route sends. */
function makeDb({ error = null } = {}) {
  const captured = { updates: null, id: null, table: null }
  const db = {
    captured,
    from(table) {
      captured.table = table
      return {
        update(updates) {
          captured.updates = updates
          return { eq(_col, id) { captured.id = id; return Promise.resolve({ error }) } }
        },
      }
    },
  }
  return db
}

/** A heartbeat request. `body` of undefined models an empty/invalid body. */
function req(body) {
  return {
    headers: { get: () => 'Bearer bbr_x' },
    json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body)),
  }
}

/** The real wire shape: champ-bridge's postHeartbeat SPREADS telemetry flat. */
const HEALTHY_BODY = {
  software_version: '1.4.2',
  status: 'online',
  pending_samples: 0,
  uptime_s: 91_233,
  adapters: {
    ant: { protocol: 'ant', fake: false, stick_present: true, seen: 3 },
    ble: { protocol: 'ble', fake: false, powered_on: true, connections: 2 },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyBridgeToken.mockResolvedValue({ bridgeId: BRIDGE_ID, locationId: 'loc-A' })
})

describe('POST /api/bridge/heartbeat — existing contract', () => {
  it('401s without a valid bridge token, and touches nothing', () => {
    verifyBridgeToken.mockResolvedValue(null)
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    return POST(req(HEALTHY_BODY)).then(async (res) => {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' })
      expect(db.captured.updates).toBe(null)
    })
  })

  it('answers { ok, server_time } and nothing else', async () => {
    // The bridge parses this to detect clock skew. BRIDGE-BLIND.1 stores
    // telemetry; it does not report on it.
    createServerClient.mockReturnValue(makeDb())
    const json = await (await POST(req(HEALTHY_BODY))).json()
    expect(Object.keys(json).sort()).toEqual(['ok', 'server_time'])
    expect(json.ok).toBe(true)
    expect(Number.isFinite(Date.parse(json.server_time))).toBe(true)
  })

  it('still marks the bridge online and stamps last_seen_at', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(HEALTHY_BODY))
    expect(db.captured.table).toBe('ble_bridges')
    expect(db.captured.id).toBe(BRIDGE_ID)
    expect(db.captured.updates.status).toBe('online')
    expect(db.captured.updates.software_version).toBe('1.4.2')
    expect(Number.isFinite(Date.parse(db.captured.updates.last_seen_at))).toBe(true)
  })

  it('honours a self-reported error status', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req({ ...HEALTHY_BODY, status: 'error' }))
    expect(db.captured.updates.status).toBe('error')
  })

  it('does not fail the bridge over a soft DB error', async () => {
    createServerClient.mockReturnValue(makeDb({ error: { message: 'boom' } }))
    const res = await POST(req(HEALTHY_BODY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, error: 'persist_failed' })
  })
})

describe('POST /api/bridge/heartbeat — telemetry persistence', () => {
  it('persists the flat telemetry the bridge really sends', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(HEALTHY_BODY))
    const u = db.captured.updates
    expect(u.last_ant_ok).toBe(true)
    expect(u.last_ble_ok).toBe(true)
    expect(u.last_pending_samples).toBe(0)
    expect(u.last_telemetry).toEqual({
      pending_samples: 0,
      uptime_s: 91_233,
      adapters: HEALTHY_BODY.adapters,
    })
  })

  it('records the 2026-08-12 defect instead of discarding it', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req({
      ...HEALTHY_BODY,
      adapters: {
        ant: { protocol: 'ant', stick_present: true, seen: 0 },
        ble: { protocol: 'ble', powered_on: false, connections: 0 },
      },
    }))
    expect(db.captured.updates.last_ble_ok).toBe(false)
    expect(db.captured.updates.last_ant_ok).toBe(true)
  })

  it('stamps last_telemetry_at with the same instant as last_seen_at', async () => {
    // The GAP between the two is the tell for a bridge that is alive but on
    // software too old to say anything about itself; they must not drift
    // within a single heartbeat.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req(HEALTHY_BODY))
    expect(db.captured.updates.last_telemetry_at).toBe(db.captured.updates.last_seen_at)
  })

  it('does not store the auth/version fields riding in the same flat body', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req({ ...HEALTHY_BODY, api_token: 'secret' }))
    expect(Object.keys(db.captured.updates.last_telemetry).sort())
      .toEqual(['adapters', 'pending_samples', 'uptime_s'])
  })
})

describe('POST /api/bridge/heartbeat — a bridge that sends no telemetry', () => {
  const telemetryKeys = [
    'last_telemetry', 'last_telemetry_at', 'last_pending_samples', 'last_ant_ok', 'last_ble_ok',
  ]

  it('leaves every telemetry column ALONE for a bridge on older software', async () => {
    // SHIPS DARK, and load-bearing: writing nulls here would blank whatever a
    // newer bridge had reported, clearing a live adapter_down alert and
    // re-raising it on the next good heartbeat.
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(req({ software_version: '1.0.0', status: 'online' }))
    for (const k of telemetryKeys) expect(k in db.captured.updates).toBe(false)
    expect(db.captured.updates.last_seen_at).toBeTruthy()
  })

  it('survives an empty or unparseable body, as it always did', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req(undefined))
    expect((await res.json()).ok).toBe(true)
    expect(db.captured.updates.status).toBe('online')
    for (const k of telemetryKeys) expect(k in db.captured.updates).toBe(false)
  })

  it('never fails the heartbeat over a hostile telemetry payload', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({
      software_version: '1.4.2',
      adapters: { ant: 'not-an-object', ble: ['nope'] },
      pending_samples: 'lots',
    }))
    expect((await res.json()).ok).toBe(true)
    // The adapters key was present, so the flags are explicitly unknown —
    // never a fault.
    expect(db.captured.updates.last_ant_ok).toBe(null)
    expect(db.captured.updates.last_ble_ok).toBe(null)
  })
})
