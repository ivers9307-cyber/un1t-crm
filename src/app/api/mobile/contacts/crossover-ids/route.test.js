// UN1THARD.8 / ORGCONTACTS.2 — the phone directory's crossover ids: the
// contacts with a relationship at the active studio whose PRIMARY studio is
// elsewhere, read off public.studio_contacts (mig 765), gated on the mobile
// contacts permission at the active studio, best-effort, capped (the phone
// sends them as an id.in() URL). The contract is unchanged: { ids }.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', async (orig) => ({ ...(await orig()), hasMobilePermission: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { logWarn } from '@/lib/log'
import { GET, MOBILE_CROSSOVER_ID_CAP } from './route.js'

const HATCH = { id: 'loc-hatch', name: 'Hatch Street' }
const user = (over = {}) => ({ id: 'u1', role: 'staff', locations: [HATCH], activeLocation: HATCH, ...over })

// A view-reading fake: records the chain, answers pages of `rows` by range.
function viewDb(rows, { error = null } = {}) {
  const calls = []
  return {
    calls,
    rpc: () => { throw new Error('the route reads the view, never the RPC') },
    from(table) {
      const call = { table, select: null, filters: [], order: [], range: null }
      calls.push(call)
      const b = {
        select(c) { call.select = c; return b },
        eq(c, v) { call.filters.push(['eq', c, v]); return b },
        order(c, o) { call.order.push([c, o]); return b },
        range(a, z) { call.range = [a, z]; return b },
        then(res, rej) {
          const out = error ? { data: null, error } : { data: rows.slice(call.range[0], call.range[1] + 1), error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return b
    },
  }
}
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `c-${from + i}` }))

beforeEach(() => {
  getCurrentUser.mockReset()
  hasMobilePermission.mockReset()
  logWarn.mockReset()
})

describe('GET /api/mobile/contacts/crossover-ids', () => {
  it("returns the ids with a relationship at the active studio whose primary studio is elsewhere, from studio_contacts", async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(true)
    db = viewDb([{ id: 'c-1' }, { id: 'c-2' }])
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { ids: ['c-1', 'c-2'] } })
    const [call] = db.calls
    expect(call.table).toBe('studio_contacts')
    expect(call.select).toBe('id')
    expect(call.filters).toEqual([['eq', 'studio_location_id', 'loc-hatch'], ['eq', 'studio_is_crossover', true]])
    expect(call.order).toEqual([['id', { ascending: true }]])
    expect(hasMobilePermission).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'contacts')
  })

  it('403s a caller without the mobile contacts permission, without reading', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(false)
    db = viewDb([{ id: 'c-1' }])
    expect((await GET()).status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it('401s signed out and 400s with no active studio', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    getCurrentUser.mockResolvedValue(user({ activeLocation: null }))
    hasMobilePermission.mockReturnValue(true)
    expect((await GET()).status).toBe(400)
  })

  it('answers an empty list when the view read fails (the directory falls back to own contacts), logged', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(true)
    db = viewDb([], { error: { message: 'boom', code: '42P01' } })
    expect(await (await GET()).json()).toEqual({ success: true, data: { ids: [] } })
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('caps the list at 100 and logs (the phone sends it as an id.in() URL); reads no further page past the cap', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(true)
    db = viewDb(ids(MOBILE_CROSSOVER_ID_CAP + 25))
    const body = await (await GET()).json()
    expect(MOBILE_CROSSOVER_ID_CAP).toBe(100)
    expect(body.data.ids).toHaveLength(MOBILE_CROSSOVER_ID_CAP)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].range).toEqual([0, MOBILE_CROSSOVER_ID_CAP])
  })
})
