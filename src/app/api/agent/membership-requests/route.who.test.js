// APPROVALSQ.2 — GET returns who decided each row, by name only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()),
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'manager', activeLocation: { id: 'L1' }, locations: [{ id: 'L1' }] })),
  getUserLocationIds: vi.fn(() => ['L1']),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

import { logWarn } from '@/lib/log'
import { getUserLocationIds, getCurrentUser } from '@/lib/auth'
import { GET } from './route.js'

const rows = [
  { id: 'r1', location_id: 'L1', status: 'declined', decided_by: 'p1' },
  { id: 'r2', location_id: 'L1', status: 'declined', decided_by: 'p2' },
  { id: 'r3', location_id: 'L1', status: 'declined', decided_by: 'p1' },
  { id: 'r4', location_id: 'L1', status: 'pending', decided_by: null },
]

let profileReads
function makeDb(reqRows, profiles) {
  return {
    from(table) {
      if (table === 'profiles') {
        const b = {
          select: (cols) => { b.cols = cols; return b },
          in: async (col, ids) => { profileReads.push({ cols: b.cols, col, ids }); return profiles() },
        }
        return b
      }
      const b = {
        select: () => b, eq: () => b, order: () => b, limit: async () => ({ data: reqRows, error: null }),
        range: async () => ({ data: reqRows, error: null }),
      }
      return b
    },
  }
}

const history = () => GET(new Request('http://x/api/agent/membership-requests'))
const conversation = () => GET(new Request('http://x/api/agent/membership-requests?conversation_id=11111111-1111-1111-1111-111111111111'))

beforeEach(() => { vi.clearAllMocks(); profileReads = [] })

describe.each([['history', history], ['conversation', conversation]])('GET %s', (_n, run) => {
  it('attaches names, drops decided_by, reads profiles once by named columns', async () => {
    db = makeDb(rows, async () => ({ data: [{ id: 'p1', full_name: 'Sarah', role: 'manager' }, { id: 'p2', full_name: 'Tom', role: 'owner' }], error: null }))
    const j = await (await run()).json()
    expect(j.requests.map(r => r.decided_by_name)).toEqual(['Sarah', 'Tom', 'Sarah', null])
    expect(j.requests.every(r => !('decided_by' in r))).toBe(true)
    expect(profileReads).toHaveLength(1)
    expect(profileReads[0].cols).toBe('id, full_name, role')
    expect(profileReads[0].ids.sort()).toEqual(['p1', 'p2'])
  })

  it('a failed profiles read still returns the list with null names and logs', async () => {
    db = makeDb(rows, async () => ({ data: null, error: { message: 'boom' } }))
    const j = await (await run()).json()
    expect(j.success).toBe(true)
    expect(j.requests).toHaveLength(4)
    expect(j.requests.every(r => r.decided_by_name === null && !('decided_by' in r))).toBe(true)
    expect(logWarn).toHaveBeenCalled()
  })

  it('makes no profiles read when no row has a decider', async () => {
    db = makeDb([{ id: 'r4', location_id: 'L1', status: 'pending', decided_by: null }], async () => ({ data: [], error: null }))
    const j = await (await run()).json()
    expect(j.requests[0].decided_by_name).toBeNull()
    expect(profileReads).toHaveLength(0)
  })
})

describe.each([['history', history], ['conversation', conversation]])('GET %s support names', (_n, run) => {
  const profiles = async () => ({ data: [{ id: 'p1', full_name: 'Sarah', role: 'master' }, { id: 'p2', full_name: 'Tom', role: 'owner' }], error: null })
  const viewer = (role, extra = {}) => getCurrentUser.mockResolvedValueOnce({ id: 'u1', role, activeLocation: { id: 'L1' }, locations: [{ id: 'L1' }], ...extra })

  it('shows Support for a master decider to a manager, and leaves others alone', async () => {
    db = makeDb(rows, profiles); viewer('manager')
    const j = await (await run()).json()
    expect(j.requests.map(r => r.decided_by_name)).toEqual(['Support', 'Tom', 'Support', null])
  })

  it('shows the real name of a master decider to a master', async () => {
    db = makeDb(rows, profiles); viewer('master')
    const j = await (await run()).json()
    expect(j.requests.map(r => r.decided_by_name)).toEqual(['Sarah', 'Tom', 'Sarah', null])
  })

  it('a master by profileRole counts as a master viewer (same rule as the registry)', async () => {
    db = makeDb(rows, profiles); viewer('owner', { profileRole: 'master' })
    const j = await (await run()).json()
    expect(j.requests[0].decided_by_name).toBe('Sarah')
  })

  it('never returns role or decided_by', async () => {
    db = makeDb(rows, profiles); viewer('manager')
    const j = await (await run()).json()
    expect(j.requests.every(r => !('role' in r) && !('decided_by' in r))).toBe(true)
    expect(JSON.stringify(j)).not.toContain('master')
  })
})

describe('GET conversation outside the caller\'s studios', () => {
  it('returns no requests and never reads profiles', async () => {
    getUserLocationIds.mockReturnValueOnce(['L2'])
    db = makeDb(rows, async () => ({ data: [{ id: 'p1', full_name: 'Sarah' }], error: null }))
    const res = await conversation()
    expect(await res.json()).toEqual({ success: true, requests: [] })
    expect(profileReads).toHaveLength(0)
  })
})

// ROUTEWRAP.R14 — the route signs in through withAuth; the manager gate on the
// history form keeps its place and words.
describe('GET /api/agent/membership-requests — withAuth', () => {
  it('401 signed out, for both forms', async () => {
    db = makeDb(rows, async () => ({ data: [], error: null }))
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await history()).status).toBe(401)
    getCurrentUser.mockResolvedValueOnce(null)
    expect((await conversation()).status).toBe(401)
  })

  it('403 "Forbidden" on the history for a staff role at the active studio', async () => {
    db = makeDb(rows, async () => ({ data: [], error: null }))
    getCurrentUser.mockResolvedValueOnce({ id: 'u2', role: 'staff', activeLocation: { id: 'L1' }, locations: [{ id: 'L1' }] })
    const res = await history()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('a failed history read is a 500 without the database text', async () => {
    db = {
      from: () => {
        const b = { select: () => b, eq: () => b, order: () => b, range: async () => ({ data: null, error: { message: 'relation agent_membership_requests is locked' } }) }
        return b
      },
    }
    const res = await history()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the requests.' })
  })
})
