// TZ.3 — GET (preflight) and PUT (change) /api/locations/[id]/timezone.
//
// D2 = A (Richard, 11 Oct 2026): an owner or master may change the zone AT ANY
// TIME. There is no "future data" refusal and no master-only force path: the
// preflight only shows counts, and the change needs the location's name typed.
//
// What is pinned here:
//   - the gate, in order: session (401) → membership (404, never confirming an
//     id) → owner-or-master AT THE TARGET (403 for a manager) → body (400)
//   - the zone is validated and canonicalised (canonicalZone); fixed offsets
//     and unknown names are 400 with nothing written
//   - confirm_name must be the location's name, or 400 confirm_mismatch
//   - the same zone (in any spelling) is a 200 no-op: no write, no audit, no
//     cache bust, no confirm needed
//   - a real change with future data still applies (D2 = A): the service-role
//     update of { timezone, updated_at }, the drip broadcasts follow, the
//     instance cache is dropped, and one audit row names from, to and the counts
//   - a DB refusal (22023 from the mig 719 trigger) is a 400 and nothing after
//     it runs; a failed broadcast follow does NOT undo the change (a warning)
//
// @/lib/auth is the REAL module with only getCurrentUser mocked (Style B).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/timezone-change', async () => {
  const actual = await vi.importActual('@/lib/timezone-change')
  return { ...actual, timezoneChangePreflight: vi.fn(), followBroadcastZone: vi.fn() }
})
vi.mock('@/lib/location-time', async () => {
  const actual = await vi.importActual('@/lib/location-time')
  return { ...actual, resetLocationZoneCache: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'
import { timezoneChangePreflight, followBroadcastZone } from '@/lib/timezone-change'
import { resetLocationZoneCache } from '@/lib/location-time'
import { logWarn } from '@/lib/log'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const OWNER_A = {
  id: 'u1', email: 'owner@example.test', full_name: 'Owner A',
  role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
const MANAGER_A = {
  id: 'u4', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
const OWNER_A_STAFF_B = {
  id: 'u2', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

const FUTURE = { bookings: 12, shift_blocks: 30, race_events: 1, hyrox_blocks: 0, pending_enrolments: null,
  sonos_schedules: 2, shelly_devices: 0, drip_broadcasts: 1 }
const PREFLIGHT = { zone: 'Europe/Dublin', today: '2026-10-25', future: FUTURE, unknown: ['pending_enrolments'], hasFutureData: true }

// The route's two locations chains:
//   .select('id, name, timezone').eq('id', id).maybeSingle()
//   .update({ timezone, updated_at }).eq('id', id).select('id')
function makeDb({ rows = {}, readError = null, updateError = null, updatedRows } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in the route (counts live in the lib)`)
      return {
        select(cols) {
          return {
            eq: (col, val) => {
              if (col !== 'id') throw new Error(`unexpected .eq('${col}')`)
              return {
                maybeSingle: async () => (readError
                  ? { data: null, error: readError }
                  : { data: rows[val] ? { id: val, ...rows[val], _cols: cols } : null, error: null }),
              }
            },
          }
        },
        update(payload) {
          return {
            eq: (col, val) => {
              if (col !== 'id') throw new Error(`unexpected update .eq('${col}')`)
              return {
                select: async (cols) => {
                  if (cols !== 'id') throw new Error('update must return only id')
                  updates.push({ payload, id: val })
                  if (updateError) return { data: null, error: updateError }
                  return { data: updatedRows ?? (rows[val] ? [{ id: val }] : []), error: null }
                },
              }
            },
          }
        },
      }
    },
  }
}

const props = (id) => ({ params: Promise.resolve({ id }) })
const put = (id, body) => new Request(`http://localhost/api/locations/${id}/timezone`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/timezone`)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: 'Europe/Dublin' }, [LOC_B]: { name: 'Studio B', timezone: 'Europe/Dublin' } } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER_A)
  timezoneChangePreflight.mockResolvedValue(PREFLIGHT)
  followBroadcastZone.mockResolvedValue({ followed: 1, kept: [], error: null })
})

describe('the gate (GET and PUT)', () => {
  for (const [name, call] of [['GET', (id) => GET(get(id), props(id))], ['PUT', (id) => PUT(put(id, { timezone: 'America/New_York', confirm_name: 'Studio A' }), props(id))]]) {
    it(`${name}: no session → 401`, async () => {
      getCurrentUser.mockResolvedValue(null)
      expect((await call(LOC_A)).status).toBe(401)
    })
    it(`${name}: a location the caller is not at → 404, nothing read`, async () => {
      expect((await call(LOC_B)).status).toBe(404)
      expect(createServerClient).not.toHaveBeenCalled()
    })
    it(`${name}: a manager at the target → 403`, async () => {
      getCurrentUser.mockResolvedValue(MANAGER_A)
      expect((await call(LOC_A)).status).toBe(403)
      expect(db.updates).toHaveLength(0)
    })
    it(`${name}: an owner at A who is staff at B is judged at B → 403`, async () => {
      getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
      expect((await call(LOC_B)).status).toBe(403)
    })
  }
})

describe('GET — the preflight', () => {
  it('returns the location, today in its current zone and the counts (unknown stays null)', async () => {
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({
      location: { id: LOC_A, name: 'Studio A', timezone: 'Europe/Dublin' },
      today: '2026-10-25', future: FUTURE, unknown: ['pending_enrolments'], hasFutureData: true,
    })
    expect(body.data.future.pending_enrolments).toBeNull()
    expect(timezoneChangePreflight).toHaveBeenCalledWith(db, expect.objectContaining({ id: LOC_A, timezone: 'Europe/Dublin' }))
  })

  it('master may run it anywhere', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(200)
  })

  it('no such row → 404; a failed read → 500, never an empty preflight', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(makeDb({ rows: {} }))
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(404)
    createServerClient.mockReturnValue(makeDb({ readError: { message: 'down' } }))
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(500)
  })
})

describe('PUT — the change', () => {
  it('an owner changes the zone even with future data (D2 = A): write, follow, cache bust, audit', async () => {
    const res = await PUT(put(LOC_A, { timezone: 'america/new_york', confirm_name: 'Studio A' }), props(LOC_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ timezone: 'America/New_York', previous: 'Europe/Dublin', changed: true,
      future: FUTURE, broadcasts: { followed: 1, kept: [] } })
    expect(body.warning).toBeUndefined()

    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].id).toBe(LOC_A)
    expect(Object.keys(db.updates[0].payload).sort()).toEqual(['timezone', 'updated_at'])
    expect(db.updates[0].payload.timezone).toBe('America/New_York')
    expect(followBroadcastZone).toHaveBeenCalledWith(db, LOC_A, 'Europe/Dublin', 'America/New_York')
    expect(resetLocationZoneCache).toHaveBeenCalledWith(LOC_A)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      category: 'business',
      action: 'location.timezone_changed',
      actor: { id: 'u1', full_name: 'Owner A', email: 'owner@example.test' },
      target: { resource: `location/${LOC_A}`, label: 'Studio A' },
      locationId: LOC_A,
      details: { from: 'Europe/Dublin', to: 'America/New_York', future: FUTURE, unknown: ['pending_enrolments'],
        broadcasts: { followed: 1, kept: 0, error: null } },
    })
  })

  it('the counts are taken BEFORE the write (judged in the old zone)', async () => {
    const order = []
    timezoneChangePreflight.mockImplementation(async () => { order.push('preflight'); return PREFLIGHT })
    followBroadcastZone.mockImplementation(async () => { order.push('follow'); return { followed: 0, kept: [], error: null } })
    resetLocationZoneCache.mockImplementation(() => { order.push('reset') })
    logAuditEvent.mockImplementation(async () => { order.push('audit'); return { logged: true } })
    await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))
    expect(order).toEqual(['preflight', 'follow', 'reset', 'audit'])
    expect(timezoneChangePreflight.mock.calls[0][1]).toMatchObject({ timezone: 'Europe/Dublin' })
  })

  it('master changes it too, at any studio', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put(LOC_B, { timezone: 'Australia/Perth', confirm_name: 'Studio B' }), props(LOC_B))
    expect(res.status).toBe(200)
    expect(db.updates[0]).toMatchObject({ id: LOC_B, payload: { timezone: 'Australia/Perth' } })
  })

  it('a typed name with stray spaces round it still matches; any other name is 400 confirm_mismatch', async () => {
    expect((await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: '  Studio A ' }), props(LOC_A))).status).toBe(200)
    vi.clearAllMocks()
    db = makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: 'Europe/Dublin' } } })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(OWNER_A)
    for (const wrong of ['studio a', 'Studio', '', 'Studio B']) {
      const res = await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: wrong }), props(LOC_A))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('confirm_mismatch')
    }
    expect(db.updates).toHaveLength(0)
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(resetLocationZoneCache).not.toHaveBeenCalled()
  })

  it('a missing confirm_name is a 400 body error', async () => {
    const res = await PUT(put(LOC_A, { timezone: 'Asia/Tokyo' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it.each(['Mars/Olympus', '+05:30', 'Etc/GMT-5', 'UTC+1', ''])('refuses %s with 400 and writes nothing', async (tz) => {
    const res = await PUT(put(LOC_A, { timezone: tz, confirm_name: 'Studio A' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.updates).toHaveLength(0)
    expect(followBroadcastZone).not.toHaveBeenCalled()
  })

  it('the same zone in any spelling is a 200 no-op: no write, no audit, no cache bust, no confirm needed', async () => {
    const res = await PUT(put(LOC_A, { timezone: 'europe/dublin', confirm_name: 'anything' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ timezone: 'Europe/Dublin', previous: 'Europe/Dublin', changed: false })
    expect(db.updates).toHaveLength(0)
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect(resetLocationZoneCache).not.toHaveBeenCalled()
    expect(followBroadcastZone).not.toHaveBeenCalled()
  })

  it('Asia/Kolkata is compared and stored as the runtime\'s canonical name', async () => {
    db = makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: 'Asia/Calcutta' } } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put(LOC_A, { timezone: 'Asia/Kolkata', confirm_name: 'Studio A' }), props(LOC_A))
    expect((await res.json()).data.changed).toBe(false)
    expect(db.updates).toHaveLength(0)
  })

  it('a NULL stored zone counts as the Dublin floor (from), so changing it to New York is a real change', async () => {
    db = makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: null } } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put(LOC_A, { timezone: 'America/New_York', confirm_name: 'Studio A' }), props(LOC_A))
    expect((await res.json()).data).toMatchObject({ previous: 'Europe/Dublin', changed: true })
  })

  it('the DB trigger refusing the zone (22023) is a 400; nothing follows, nothing is logged as changed', async () => {
    db = makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: 'Europe/Dublin' } }, updateError: { code: '22023', message: 'locations.timezone X is not an IANA zone' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(followBroadcastZone).not.toHaveBeenCalled()
    expect(resetLocationZoneCache).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('any other write failure is a 500; a write that touched no row is a 404', async () => {
    createServerClient.mockReturnValue(makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: 'Europe/Dublin' } }, updateError: { code: '57014', message: 'timeout' } }))
    expect((await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))).status).toBe(500)
    createServerClient.mockReturnValue(makeDb({ rows: { [LOC_A]: { name: 'Studio A', timezone: 'Europe/Dublin' } }, updatedRows: [] }))
    expect((await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))).status).toBe(404)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('a failed broadcast follow does not undo the change: 200 with a warning, and the audit says so', async () => {
    followBroadcastZone.mockResolvedValue({ followed: 0, kept: [], error: 'write down' })
    const res = await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBe('broadcasts_not_followed')
    expect(resetLocationZoneCache).toHaveBeenCalledWith(LOC_A)
    expect(logAuditEvent.mock.calls[0][0].details.broadcasts).toEqual({ followed: 0, kept: 0, error: 'write down' })
  })

  it('broadcasts an operator set to another zone are listed back, not moved', async () => {
    followBroadcastZone.mockResolvedValue({ followed: 0, kept: [{ id: 'b3', name: 'London drip', send_window_tz: 'Europe/London' }], error: null })
    const body = await (await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))).json()
    expect(body.data.broadcasts.kept).toEqual([{ id: 'b3', name: 'London drip', send_window_tz: 'Europe/London' }])
  })

  it('an audit row that did not land is warned about, and the change still stands', async () => {
    logAuditEvent.mockResolvedValue({ logged: false, error: 'insert failed' })
    const res = await PUT(put(LOC_A, { timezone: 'Asia/Tokyo', confirm_name: 'Studio A' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('locations/timezone', 'audit row not written', expect.objectContaining({ locationId: LOC_A }))
  })
})
