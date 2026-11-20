// GET /api/sequences/[id]/runs through the real withAuth wrapper: manager and
// the builder rule somewhere, the sequence's studio (404 outside), then both
// again there (tests/role-sweep/sequence-builder-routes.test.js has the table).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const SEQ = 'ef000000-0000-4000-8000-000000000001'
const SEQ_FAR = 'ef000000-0000-4000-8000-000000000002'
const get = (id) => GET(new Request(`http://localhost/api/sequences/${id}/runs`), { params: Promise.resolve({ id }) })
const managerAtB = () => person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager', permissions: { email: true } } }, LOC_A)
const seed = (errors) => createServerClient.mockReturnValue(createFakeDb({ tables: {
  email_sequences: [{ id: SEQ, location_id: LOC_B, name: 'Welcome' }, { id: SEQ_FAR, location_id: LOC_OTHER, name: 'Theirs' }],
  sequence_steps: [{ id: 'st-1', sequence_id: SEQ, step_order: 1 }],
  contacts: [{ id: 'c-1', location_id: LOC_B, first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com' }],
  sequence_enrollments: [{ id: 'en-1', sequence_id: SEQ, contact_id: 'c-1', status: 'active', current_step_order: 1, enrolled_at: '2026-11-01T00:00:00Z' }],
}, errors }))

beforeEach(() => { vi.clearAllMocks(); seed() })

describe('GET /api/sequences/[id]/runs', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(SEQ)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Manager+ required" for staff everywhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'staff', permissions: { email: true } } }, LOC_B))
    const res = await get(SEQ)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
  })

  it('404 for another studio\'s sequence', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    expect((await get(SEQ_FAR)).status).toBe(404)
  })

  it('a manager at the sequence\'s studio reads the recent runs', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    const res = await get(SEQ)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.step_count).toBe(1)
    expect(data.runs.map((r) => r.id)).toEqual(['en-1'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    seed({ sequence_enrollments: { select: { message: 'secret detail' } } })
    const res = await get(SEQ)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
