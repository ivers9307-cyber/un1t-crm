// POST /api/contacts/merge through the real withAuth wrapper. Every check runs
// in its old order before mergeContacts is called: owner somewhere 403, body
// 400, same id 400, both contacts 404, same studio 400, membership 403, owner
// there 403. A failed merge answers a fixed line, never the database text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/contact-merge', () => ({ mergeContacts: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { mergeContacts } = await import('@/lib/contact-merge')
const { POST } = await import('./route.js')

const S = 'ea000000-0000-4000-8000-000000000001'
const L = 'ea000000-0000-4000-8000-000000000002'
const FAR = 'ea000000-0000-4000-8000-000000000003'
const post = (body) => POST(new Request('http://localhost/api/contacts/merge', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const ownerAtB = () => person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'owner' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { contacts: [
    { id: S, location_id: LOC_B, name: 'One' },
    { id: L, location_id: LOC_B, name: 'Two' },
    { id: FAR, location_id: LOC_OTHER, name: 'Three' },
  ] } }))
  mergeContacts.mockResolvedValue({ survivor: { id: S }, folded: {} })
})

describe('POST /api/contacts/merge', () => {
  it('401 signed out, nothing merged', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ survivor_id: S, loser_id: L })).status).toBe(401)
    expect(mergeContacts).not.toHaveBeenCalled()
  })

  it('403 for a caller who is owner nowhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'manager' } }, LOC_B))
    const res = await post({ survivor_id: S, loser_id: L })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Owner or master required' })
  })

  it('400 for the same contact twice; 404 for a missing one', async () => {
    getCurrentUser.mockResolvedValue(ownerAtB())
    expect((await post({ survivor_id: S, loser_id: S })).status).toBe(400)
    expect((await post({ survivor_id: S, loser_id: 'ea000000-0000-4000-8000-0000000000ff' })).status).toBe(404)
    expect(mergeContacts).not.toHaveBeenCalled()
  })

  it('403 for an owner at the active studio merging at a studio where they are staff', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'staff' } }, LOC_A))
    expect((await post({ survivor_id: S, loser_id: L })).status).toBe(403)
    expect(mergeContacts).not.toHaveBeenCalled()
  })

  it('an owner at the contacts\' studio merges them', async () => {
    getCurrentUser.mockResolvedValue(ownerAtB())
    const res = await post({ survivor_id: S, loser_id: L })
    expect(res.status).toBe(200)
    expect(mergeContacts).toHaveBeenCalledWith(expect.anything(), { survivorId: S, loserId: L })
  })

  it('a failed merge is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(ownerAtB())
    mergeContacts.mockRejectedValueOnce(new Error('mergeContacts: merge failed: secret detail'))
    const res = await post({ survivor_id: S, loser_id: L })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Merge failed' })
  })
})
