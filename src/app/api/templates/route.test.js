// GET/POST /api/templates through the real withAuth wrapper. GET is membership
// only (the picker list); POST needs email at the template's studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const get = (qs = '') => GET(new Request(`http://localhost/api/templates${qs}`))
const post = (body) => POST(new Request('http://localhost/api/templates', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const emailAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { email: a } }, [LOC_B]: { role: 'manager', permissions: { email: b } } }, LOC_A)
let db
const seed = (errors) => {
  db = createFakeDb({ tables: { email_templates: [
    { id: 't-a', location_id: LOC_A, name: 'A', updated_at: '2026-11-01T00:00:00Z' },
    { id: 't-far', location_id: LOC_OTHER, name: 'Far', updated_at: '2026-11-02T00:00:00Z' },
  ] }, errors })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed() })

describe('GET /api/templates', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 for a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(emailAt(true, true))
    expect((await get(`?location_id=${LOC_OTHER}`)).status).toBe(403)
  })

  it('lists only the caller\'s studios', async () => {
    getCurrentUser.mockResolvedValue(emailAt(false, false))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).templates.map((t) => t.id)).toEqual(['t-a'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(emailAt(true, true))
    seed({ email_templates: { select: { message: 'secret detail' } } })
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

describe('POST /api/templates', () => {
  it('401 signed out, nothing created', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ name: 'New', location_id: LOC_B })).status).toBe(401)
    expect(db.tables.email_templates).toHaveLength(2)
  })

  it('403 without email at the template\'s studio, though held at the active one', async () => {
    getCurrentUser.mockResolvedValue(emailAt(true, false))
    const res = await post({ name: 'New', location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'No email permission at this location' })
  })

  it('creates a template at the body\'s studio', async () => {
    getCurrentUser.mockResolvedValue(emailAt(false, true))
    const res = await post({ name: 'New', location_id: LOC_B })
    expect(res.status).toBe(200)
    expect((await res.json()).template).toMatchObject({ name: 'New', location_id: LOC_B, created_by: 'user-1' })
  })
})
