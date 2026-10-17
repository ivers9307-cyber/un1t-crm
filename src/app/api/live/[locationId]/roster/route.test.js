// UN1TBOOK.12 — GET /api/live/[locationId]/roster: the who's-coming list under
// `class_roster`, with no heart-rate data, no straps and no door control.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn((user) => (user?.locations || []).map((l) => l.id)),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// Only the IO read is mocked; mergeRosterWithSessions is the real function.
vi.mock('@/lib/class-bookings', async () => ({
  ...(await vi.importActual('@/lib/class-bookings')),
  getClassRoster: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getClassRoster } from '@/lib/class-bookings'
import { logError } from '@/lib/log'

const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const props = (locationId) => ({ params: Promise.resolve({ locationId }) })
const req = () => new Request('http://localhost/api/live/x/roster')

/** A user holding `perms` (per-location overrides) at each location in `perms`. */
function userWith(permsByLoc, { role = 'staff', active } = {}) {
  const ids = Object.keys(permsByLoc)
  return {
    id: 'u1',
    role,
    isMaster: false,
    activeLocation: active ? { id: active } : null,
    locations: ids.map((id) => ({ id, features: {} })),
    assignmentsByLocation: Object.fromEntries(ids.map((id) => [id, { role, permissions: permsByLoc[id] }])),
    roleTemplatesByLocation: {},
  }
}

function throwingDb() {
  return { from: () => { throw new Error('database touched before the gate refused') } }
}

/** ble_bridges chain: select().eq().limit() → { data, error }. */
function bridgesDb(result) {
  const calls = []
  const db = {
    calls,
    from: (table) => {
      calls.push(table)
      return { select: () => ({ eq: () => ({ limit: () => Promise.resolve(result) }) }) }
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getClassRoster.mockResolvedValue({ occurrence: null, roster: [] })
})

describe('GET /api/live/[locationId]/roster', () => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(throwingDb())
    expect((await GET(req(), props(HATCH))).status).toBe(401)
  })

  it('403s a member of another location without touching the db', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [STILL]: { class_roster: true } }))
    createServerClient.mockReturnValue(throwingDb())
    expect((await GET(req(), props(HATCH))).status).toBe(403)
    expect(getClassRoster).not.toHaveBeenCalled()
  })

  it('403s a member without class_roster, naming the permission', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [HATCH]: { class_roster: false, studio_management: true } }))
    createServerClient.mockReturnValue(throwingDb())
    const res = await GET(req(), props(HATCH))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Class roster permission required')
  })

  it('gives a class_roster-only user the occurrence, roster labels and has_bridge, and no sessions or straps', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [HATCH]: { class_roster: true, studio_management: false } }))
    getClassRoster.mockResolvedValue({
      occurrence: { glofox_event_id: 'e1', name: 'Strength' },
      roster: [{ glofox_member_id: 'm1', member_name: 'Fictional Member', status: 'BOOKED', attended: false }],
    })
    const db = bridgesDb({ data: [{ id: 'b1' }], error: null })
    createServerClient.mockReturnValue(db)

    const res = await GET(req(), props(HATCH))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.occurrence).toEqual({ glofox_event_id: 'e1', name: 'Strength' })
    expect(body.roster).toEqual([
      { label: 'Fictional Member', booked: true, hasHr: false, anon: false, currentBpm: null, sessionId: null },
    ])
    expect(body.has_bridge).toBe(true)
    for (const key of ['sessions', 'available_straps', 'straps', 'test_mode_until']) {
      expect(body).not.toHaveProperty(key)
    }
    expect(db.calls).toEqual(['ble_bridges'])
  })

  it('answers has_bridge false when the location has no bridge row', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [HATCH]: { class_roster: true } }))
    createServerClient.mockReturnValue(bridgesDb({ data: [], error: null }))
    expect((await (await GET(req(), props(HATCH))).json()).has_bridge).toBe(false)
  })

  it('logs and answers has_bridge false when the bridge read fails', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [HATCH]: { class_roster: true } }))
    createServerClient.mockReturnValue(bridgesDb({ data: null, error: { message: 'boom' } }))
    const res = await GET(req(), props(HATCH))
    expect(res.status).toBe(200)
    expect((await res.json()).has_bridge).toBe(false)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('resolves class_roster at the target location, not the active one', async () => {
    // Granted at Hatch only; the active location is Stillorgan.
    getCurrentUser.mockResolvedValue(
      userWith({ [HATCH]: { class_roster: true }, [STILL]: { class_roster: false } }, { active: STILL }),
    )
    createServerClient.mockReturnValue(bridgesDb({ data: [], error: null }))
    expect((await GET(req(), props(HATCH))).status).toBe(200)
    expect((await GET(req(), props(STILL))).status).toBe(403)
  })

  it('lists ATTENDED and NO_SHOW members and skips CANCELLED', async () => {
    getCurrentUser.mockResolvedValue(userWith({ [HATCH]: { class_roster: true } }))
    getClassRoster.mockResolvedValue({
      occurrence: { glofox_event_id: 'e1' },
      roster: [
        { glofox_member_id: 'm1', member_name: 'Attended One', status: 'ATTENDED', attended: true },
        { glofox_member_id: 'm2', member_name: 'Absent Two', status: 'NO_SHOW', attended: false },
        { glofox_member_id: 'm3', member_name: 'Cancelled Three', status: 'CANCELLED', attended: false },
      ],
    })
    createServerClient.mockReturnValue(bridgesDb({ data: [], error: null }))
    const body = await (await GET(req(), props(HATCH))).json()
    expect(body.roster.map((r) => r.label)).toEqual(['Attended One', 'Absent Two'])
  })
})
