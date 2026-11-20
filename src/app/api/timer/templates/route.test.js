// CLASS-TIMER — GET/POST /api/timer/templates through the real withAuth
// wrapper: class_timer somewhere (403 "Unauthorized"), the studio, class_timer
// there. Signed out is withAuth's 401 (it was a 403 before ROUTEWRAP.R11).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const STRUCTURE = [{ type: 'work', seconds: 30 }]
const get = (loc) => GET(new Request(`http://localhost/api/timer/templates?location_id=${loc}`))
const post = (body) => POST(new Request('http://localhost/api/timer/templates', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const timerAt = (a, b) => person({ [LOC_A]: { role: 'staff', permissions: { class_timer: a } }, [LOC_B]: { role: 'staff', permissions: { class_timer: b } } }, LOC_A)
let db
const seed = (errors) => {
  db = createFakeDb({ tables: { class_timer_templates: [
    { id: 'tt-1', location_id: LOC_B, name: 'EMOM', structure: STRUCTURE, total_seconds: 30, is_active: true, updated_at: '2026-11-01T00:00:00Z' },
  ] }, errors })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed() })

describe('GET /api/timer/templates', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get(LOC_B)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 without class_timer at the asked studio', async () => {
    getCurrentUser.mockResolvedValue(timerAt(true, false))
    expect((await get(LOC_B)).status).toBe(403)
  })

  it('lists the studio\'s templates', async () => {
    getCurrentUser.mockResolvedValue(timerAt(false, true))
    const res = await get(LOC_B)
    expect(res.status).toBe(200)
    expect((await res.json()).templates.map((t) => t.id)).toEqual(['tt-1'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(timerAt(true, true))
    seed({ class_timer_templates: { select: { message: 'secret detail' } } })
    const res = await get(LOC_B)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

describe('POST /api/timer/templates', () => {
  it('401 signed out, nothing created', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ location_id: LOC_B, name: 'New', structure: STRUCTURE })).status).toBe(401)
    expect(db.tables.class_timer_templates).toHaveLength(1)
  })

  it('403 without class_timer at the body\'s studio', async () => {
    getCurrentUser.mockResolvedValue(timerAt(true, false))
    expect((await post({ location_id: LOC_B, name: 'New', structure: STRUCTURE })).status).toBe(403)
    expect(db.tables.class_timer_templates).toHaveLength(1)
  })
})
