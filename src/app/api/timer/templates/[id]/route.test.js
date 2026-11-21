// /api/timer/templates/[id] through the real withAuth wrapper, which only
// signs the caller in (401; a signed-out call was a 403 before). class_timer
// somewhere (403), the row (404, never 403 for another studio's) and
// class_timer at its studio (403) keep their order.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, PUT, DELETE } = await import('./route.js')

const T_A = '7e000000-0000-4000-8000-00000000000a'
const T_B = '7e000000-0000-4000-8000-00000000000b'
const TIMER_A = person({ [LOC_A]: { role: 'manager', permissions: { class_timer: true } } }, LOC_A)
const NO_TIMER = person({ [LOC_A]: { role: 'manager', permissions: { class_timer: false } } }, LOC_A)
const ctx = (id) => ({ params: Promise.resolve({ id }) })
const url = (id) => `http://localhost/api/timer/templates/${id}`
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { class_timer_templates: [
    { id: T_A, location_id: LOC_A, name: 'HIIT', structure: [], total_seconds: 0, glofox_program: null, is_active: true },
    { id: T_B, location_id: LOC_B, name: 'Other', structure: [], total_seconds: 0, glofox_program: null, is_active: true },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/timer/templates/[id]', () => {
  it('401 signed out on every verb (withAuth; was a 403), nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [
      await GET(new Request(url(T_A)), ctx(T_A)),
      await PUT(new Request(url(T_A), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) }), ctx(T_A)),
      await DELETE(new Request(url(T_A), { method: 'DELETE' }), ctx(T_A)),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
    expect(db.tables.class_timer_templates[0]).toMatchObject({ name: 'HIIT', is_active: true })
  })

  it('403 without class_timer anywhere', async () => {
    getCurrentUser.mockResolvedValue(NO_TIMER)
    const res = await GET(new Request(url(T_A)), ctx(T_A))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 for another studio’s template, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue(TIMER_A)
    expect((await GET(new Request(url(T_B)), ctx(T_B))).status).toBe(404)
    expect((await DELETE(new Request(url(T_B), { method: 'DELETE' }), ctx(T_B))).status).toBe(404)
    expect(db.tables.class_timer_templates[1].is_active).toBe(true)
  })

  it('reads, renames and soft-deletes the caller’s own template', async () => {
    getCurrentUser.mockResolvedValue(TIMER_A)
    const got = await GET(new Request(url(T_A)), ctx(T_A))
    expect(got.status).toBe(200)
    expect((await got.json()).template).toMatchObject({ id: T_A, name: 'HIIT' })
    const put = await PUT(new Request(url(T_A), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tabata' }) }), ctx(T_A))
    expect(put.status).toBe(200)
    expect(db.tables.class_timer_templates[0].name).toBe('Tabata')
    expect((await DELETE(new Request(url(T_A), { method: 'DELETE' }), ctx(T_A))).status).toBe(200)
    expect(db.tables.class_timer_templates[0].is_active).toBe(false)
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(TIMER_A)
    db.errors.class_timer_templates = { update: { message: 'permission denied for table class_timer_templates' } }
    const res = await DELETE(new Request(url(T_A), { method: 'DELETE' }), ctx(T_A))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not delete the template. Try again.' })
  })
})
