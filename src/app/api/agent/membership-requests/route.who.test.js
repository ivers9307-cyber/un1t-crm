// APPROVALSQ.2 — GET returns who decided each row, by name only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'manager', activeLocation: { id: 'L1' }, locations: [{ id: 'L1' }] })),
  getUserLocationIds: vi.fn(() => ['L1']),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { logWarn } from '@/lib/log'
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
    db = makeDb(rows, async () => ({ data: [{ id: 'p1', full_name: 'Sarah' }, { id: 'p2', full_name: 'Tom' }], error: null }))
    const j = await (await run()).json()
    expect(j.requests.map(r => r.decided_by_name)).toEqual(['Sarah', 'Tom', 'Sarah', null])
    expect(j.requests.every(r => !('decided_by' in r))).toBe(true)
    expect(profileReads).toHaveLength(1)
    expect(profileReads[0].cols).toBe('id, full_name')
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
