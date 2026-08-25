// SHELLY-UI.5 — the loader every device detail route is an IDOR without.
//
// Three properties, and each of them is the thing a route would get wrong:
//   1. THE TENANT FILTER IS ON THE QUERY. The fake holds both studios' rows
//      and applies the recorded .eq()s, so a loader that dropped
//      .eq('location_id', …) returns the other studio's device and fails here.
//   2. A MALFORMED ID AND A FOREIGN ID ARE INDISTINGUISHABLE. Same status, and
//      the routes build the same body from it — a 400/404 split would tell a
//      caller which of the ids they are guessing exist.
//   3. "COULD NOT READ" IS NOT "NOT YOURS". A db error answers 500, never 404,
//      because a 404 would tell an operator their own device had been deleted.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { loadDevice, requestTz, withLocationTz, DEVICE_COLUMNS } from './device-load.js'
import { logWarn } from '@/lib/log'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const DEV_A = 'd0000000-0000-4000-8000-00000000000a'
const DEV_B = 'd0000000-0000-4000-8000-00000000000b'

const row = (id, locationId, over = {}) => ({
  id, location_id: locationId, device_id: 'aabbcc112233', channel: 0, name: 'Sauna plug',
  adopted_by: 'someone', ...over,
})

// Minimal PostgREST double: estate-wide rows, filtered by the recorded .eq()s.
function makeDb({ rows = [], error = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, cols: null, filters: {} }
      calls.push(st)
      const b = {
        select: (cols) => { st.cols = cols; return b },
        eq: (col, val) => { st.filters[col] = val; return b },
        maybeSingle: async () => {
          if (error) return { data: null, error }
          const hit = rows.find((r) => Object.entries(st.filters).every(([k, v]) => r[k] === v))
          return { data: hit ?? null, error: null }
        },
      }
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('DEVICE_COLUMNS', () => {
  it('is an allowlist that never publishes adopted_by', () => {
    expect(DEVICE_COLUMNS).not.toContain('*')
    expect(DEVICE_COLUMNS).not.toContain('adopted_by')
    for (const col of ['id', 'location_id', 'device_id', 'channel', 'enabled', 'schedule_mode', 'override', 'last_applied', 'last_state']) {
      expect(DEVICE_COLUMNS.split(',').map((s) => s.trim())).toContain(col)
    }
  })
})

describe('loadDevice', () => {
  it('loads the caller’s own device', async () => {
    const db = makeDb({ rows: [row(DEV_A, LOC_A), row(DEV_B, LOC_B)] })
    const res = await loadDevice(db, LOC_A, DEV_A)
    expect(res.ok).toBe(true)
    expect(res.device.id).toBe(DEV_A)
    expect(db.calls[0].filters).toEqual({ id: DEV_A, location_id: LOC_A })
    expect(db.calls[0].cols).toBe(DEVICE_COLUMNS)
  })

  it('404s another location’s device — the filter is on the query, not a read-back', async () => {
    const db = makeDb({ rows: [row(DEV_A, LOC_A), row(DEV_B, LOC_B)] })
    const res = await loadDevice(db, LOC_A, DEV_B)
    expect(res).toEqual({ ok: false, status: 404 })
  })

  it('404s a malformed id WITHOUT touching the database', async () => {
    // A non-uuid reaches Postgres as a failed cast (22P02) and would surface
    // as a 500 carrying the id the caller sent.
    const db = makeDb({ rows: [row(DEV_A, LOC_A)] })
    const res = await loadDevice(db, LOC_A, 'not-a-uuid')
    expect(res).toEqual({ ok: false, status: 404 })
    expect(db.calls).toEqual([])
  })

  it('gives a malformed id and a foreign id the SAME answer', async () => {
    const db = makeDb({ rows: [row(DEV_A, LOC_A), row(DEV_B, LOC_B)] })
    expect(await loadDevice(db, LOC_A, 'nope')).toEqual(await loadDevice(db, LOC_A, DEV_B))
  })

  it('404s an id that simply is not there', async () => {
    const db = makeDb({ rows: [] })
    expect(await loadDevice(db, LOC_A, DEV_A)).toEqual({ ok: false, status: 404 })
  })

  it('answers 500 — not 404 — when the read itself failed', async () => {
    const db = makeDb({ error: { message: 'db down' } })
    expect(await loadDevice(db, LOC_A, DEV_A)).toEqual({ ok: false, status: 500, error: 'db down' })
  })
})

describe('requestTz', () => {
  it('returns the location’s zone', () => {
    expect(requestTz({ activeLocation: { timezone: 'America/New_York' } })).toBe('America/New_York')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('canonicalises without warning — a case change is not a rejection', () => {
    expect(requestTz({ activeLocation: { timezone: 'europe/dublin' } })).toBe('Europe/Dublin')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('falls back to Dublin silently when there is no zone at all', () => {
    expect(requestTz({ activeLocation: { timezone: null } })).toBe('Europe/Dublin')
    expect(requestTz({})).toBe('Europe/Dublin')
    expect(requestTz(undefined)).toBe('Europe/Dublin')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('WARNS on a non-empty zone that is not a zone — a typo must not run a studio on Dublin time in silence', () => {
    expect(requestTz({ activeLocation: { id: 'loc-1', timezone: 'Erp/Dublin' } })).toBe('Europe/Dublin')
    expect(logWarn).toHaveBeenCalledWith(
      'shelly-device',
      expect.stringContaining('unknown location timezone'),
      expect.objectContaining({ timezone: 'Erp/Dublin', using: 'Europe/Dublin' }),
    )
  })

  it('rejects a fixed offset — it has no DST and would be an hour wrong for half the year', () => {
    expect(requestTz({ activeLocation: { timezone: '+05:30' } })).toBe('Europe/Dublin')
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('withLocationTz', () => {
  it('grafts the session location’s zone onto a connection that has no embed', () => {
    const conn = { id: 'conn-1', host: 'h', auth_key: 'k' }
    const out = withLocationTz(conn, { activeLocation: { timezone: 'America/New_York' } })
    expect(out.locations).toEqual({ timezone: 'America/New_York' })
    expect(out.host).toBe('h')
    expect(out.auth_key).toBe('k')
    // The input is not mutated — the caller keeps holding the row it read.
    expect(conn.locations).toBeUndefined()
  })

  it('REPLACES a stale embed rather than merging it — the session location is the authority', () => {
    const conn = { locations: { timezone: 'Australia/Sydney', name: 'Somewhere else' } }
    const out = withLocationTz(conn, { activeLocation: { timezone: 'America/New_York' } })
    expect(out.locations).toEqual({ timezone: 'America/New_York' })
  })

  it('carries a null through — the engine resolves its own default from it', () => {
    expect(withLocationTz({}, {}).locations).toEqual({ timezone: null })
  })
})
