// /api/contacts/segments through the real withAuth wrapper, which only signs
// the caller in (401 'Unauthorized'; was 'Unauthorised'). The studio and the
// permission there are swept in tests/role-sweep/contact-segments.test.js;
// this pins the sign-in and that database text never reaches the browser.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const OWNER_A = person({ [LOC_A]: { role: 'owner', permissions: { contacts: true, email: true } } }, LOC_A)
const FILTER = { logic: 'and', filters: [] }
const post = (body) => POST(new Request('http://localhost/api/contacts/segments', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { contact_segments: [
    { id: '5e000000-0000-4000-8000-00000000000a', location_id: LOC_A, name: 'Lapsed', filter: FILTER },
    { id: '5e000000-0000-4000-8000-00000000000b', location_id: LOC_B, name: 'Other', filter: FILTER },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/contacts/segments', () => {
  it('401 signed out on both verbs, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await GET(new Request('http://localhost/api/contacts/segments')), await post({ name: 'New', filter: FILTER })]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
    expect(db.tables.contact_segments).toHaveLength(2)
  })

  it('403 for another studio named in the query', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await GET(new Request(`http://localhost/api/contacts/segments?location_id=${LOC_B}`))).status).toBe(403)
  })

  it('lists and saves at the active studio', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const list = await (await GET(new Request('http://localhost/api/contacts/segments'))).json()
    expect(list.segments.map((s) => s.name)).toEqual(['Lapsed'])
    expect((await post({ name: 'New', filter: FILTER })).status).toBe(200)
    expect(db.tables.contact_segments.at(-1)).toMatchObject({ location_id: LOC_A, name: 'New' })
  })

  it('failed reads and writes answer fixed 500s, never the database text', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    db.errors.contact_segments = { select: { message: 'permission denied for table contact_segments' }, insert: { message: 'value too long for type character varying(120)' } }
    let res = await GET(new Request('http://localhost/api/contacts/segments'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the segments. Try again.' })
    res = await post({ name: 'New', filter: FILTER })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not save the segment. Try again.' })
  })
})
