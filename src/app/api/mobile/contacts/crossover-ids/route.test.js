// UN1THARD.8 — the phone directory's crossover ids: the RPC's ids, gated on
// the mobile contacts permission at the active studio, best-effort, capped.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', async (orig) => ({ ...(await orig()), hasMobilePermission: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { CROSSOVER_ID_CAP } from '@/lib/contact-crossovers'
import { GET } from './route.js'

const HATCH = { id: 'loc-hatch', name: 'Hatch Street' }
const user = (over = {}) => ({ id: 'u1', role: 'staff', locations: [HATCH], activeLocation: HATCH, ...over })

function rpcDb(result) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return result },
    from: () => { throw new Error('the route reads nothing but the RPC') },
  }
}

beforeEach(() => {
  getCurrentUser.mockReset()
  hasMobilePermission.mockReset()
})

describe('GET /api/mobile/contacts/crossover-ids', () => {
  it('returns the active studio\'s crossover ids from the RPC', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(true)
    db = rpcDb({ data: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }], error: null })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { ids: ['c-1', 'c-2'] } })
    expect(db.calls).toEqual([{ name: 'crossover_contact_ids', args: { loc: 'loc-hatch' } }])
    expect(hasMobilePermission).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'contacts')
  })

  it('403s a caller without the mobile contacts permission, without calling the RPC', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(false)
    db = rpcDb({ data: [{ contact_id: 'c-1' }], error: null })
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

  it('answers an empty list when the RPC fails (the directory falls back to own contacts)', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(true)
    db = rpcDb({ data: null, error: { message: 'boom' } })
    expect(await (await GET()).json()).toEqual({ success: true, data: { ids: [] } })
  })

  it('caps the list (the phone sends it as an id.in() URL)', async () => {
    getCurrentUser.mockResolvedValue(user())
    hasMobilePermission.mockReturnValue(true)
    db = rpcDb({ data: Array.from({ length: CROSSOVER_ID_CAP + 25 }, (_, i) => ({ contact_id: `c-${i}` })), error: null })
    expect((await (await GET()).json()).data.ids).toHaveLength(CROSSOVER_ID_CAP)
  })
})
