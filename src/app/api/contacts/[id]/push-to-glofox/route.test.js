// GLOFOXWRITEJUDGE.1 (a) — the Create in Glofox button shows j.message || j.error,
// and a failed push answered { success:false, result } with neither, so staff
// read "Push failed (502)". The failure's words now ride on `error`.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOC = 'c0000000-0000-4000-8000-00000000000c'
const CONTACT = 'd0000000-0000-4000-8000-00000000000d'
const MASTER = {
  id: 'user-m', isMaster: true, profileRole: 'master', role: 'master',
  activeLocation: { id: LOC }, locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'owner' }, permissions: {},
}

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: () => {
      const chain = {}
      for (const m of ['select', 'eq']) chain[m] = () => chain
      chain.single = async () => ({ data: { id: CONTACT, location_id: LOC, email: 'a@b.com', first_name: 'A', last_name: 'B', glofox_member_id: null }, error: null })
      return chain
    },
  })),
}))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { POST } from './route.js'

const call = () => POST(new Request(`http://crm.test/api/contacts/${CONTACT}/push-to-glofox`, { method: 'POST' }), { params: Promise.resolve({ id: CONTACT }) })

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER) })

describe('POST /api/contacts/[id]/push-to-glofox', () => {
  it('a failed push says why in `error` (502)', async () => {
    findOrCreateGlofoxMember.mockResolvedValueOnce({ status: 'failed', error: 'The first name field is required.' })
    const r = await call()
    expect(r.status).toBe(502)
    expect(await r.json()).toMatchObject({ success: false, error: 'The first name field is required.' })
  })

  it('a linked or created push is unchanged (200, no error key)', async () => {
    findOrCreateGlofoxMember.mockResolvedValueOnce({ status: 'linked', glofox_member_id: 'gx-old', error: null })
    const r = await call()
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toMatchObject({ success: true, result: { status: 'linked' } })
    expect(j.error).toBeUndefined()
  })
})
