// GET /api/contacts/imports/[id]/error-csv through the real withAuth wrapper:
// manager somewhere, then the batch's studio (404 outside it), then manager there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const MINE = 'e9000000-0000-4000-8000-000000000001'
const THEIRS = 'e9000000-0000-4000-8000-000000000002'
const get = (id) => GET(new Request(`http://localhost/api/contacts/imports/${id}/error-csv`), { params: Promise.resolve({ id }) })
const managerAtB = () => person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: {
    contact_imports: [
      { id: MINE, location_id: LOC_B, source_filename: 'leads.csv', created_at: '2026-11-01T00:00:00Z' },
      { id: THEIRS, location_id: LOC_OTHER, source_filename: 'theirs.csv', created_at: '2026-11-01T00:00:00Z' },
    ],
    contact_import_rows: [
      { id: 'r1', import_id: MINE, row_number: 2, action: 'errored', raw_row: { email: 'bad' }, error_message: 'Invalid email' },
      { id: 'r2', import_id: MINE, row_number: 3, action: 'created', raw_row: { email: 'ok@example.com' } },
    ],
  } }))
})

describe('GET /api/contacts/imports/[id]/error-csv', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(MINE)).status).toBe(401)
  })

  it('403 for staff everywhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'staff' } }, LOC_B))
    expect((await get(MINE)).status).toBe(403)
  })

  it('404 for another studio\'s batch', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    expect((await get(THEIRS)).status).toBe(404)
  })

  it('a manager at the batch\'s studio gets only the failed rows', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    const res = await get(MINE)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('leads-errors.csv')
    expect(await res.text()).toBe('email,import_error\nbad,Invalid email\n')
  })
})
