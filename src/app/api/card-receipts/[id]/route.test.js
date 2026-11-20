// GET /api/card-receipts/[id] through the real withAuth wrapper: the submitter,
// or an owner/master at the receipt's studio; anyone else is a 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const REC = 'e0000000-0000-4000-8000-0000000000a1'
const get = (id = REC) => GET(new Request(`http://localhost/api/card-receipts/${id}`), { params: Promise.resolve({ id }) })
const tables = () => ({
  card_receipts: [{ id: REC, location_id: LOC_B, submitter_id: 'sub-1', status: 'submitted', amount: 12.5, merchant: 'Shop', reviewed_by: null }],
  profiles: [{ id: 'sub-1', full_name: 'Sub One', email: 'sub.one@example.com' }],
  locations: [{ id: LOC_B, name: 'Studio B' }],
})

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: tables() }))
})

describe('GET /api/card-receipts/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('404 for an owner at another studio and for a manager at the receipt\'s', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'manager' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Not found' })
  })

  it('the submitter sees it as submitter, an owner there and a master as approvers', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), id: 'sub-1' })
    let body = await (await get()).json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ id: REC, viewer_role: 'submitter', submitter: { id: 'sub-1' }, location: { id: LOC_B } })

    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    body = await (await get()).json()
    expect(body.data.viewer_role).toBe('owner')

    getCurrentUser.mockResolvedValue(MASTER)
    body = await (await get()).json()
    expect(body.data.viewer_role).toBe('master')
  })

  it('a failed read is a 400 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: tables(), errors: { card_receipts: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
