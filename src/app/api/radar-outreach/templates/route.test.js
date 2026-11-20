// RADAR-OUTREACH.1 — GET /api/radar-outreach/templates through the real
// withAuth wrapper: churn_radar at the active studio, its templates only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const body = (text) => [{ type: 'BODY', text }]
let db
const get = () => GET(new Request('http://localhost/api/radar-outreach/templates'))
const caller = (on, active = LOC_A) => person({ [LOC_A]: { role: 'staff', permissions: { churn_radar: on } }, [LOC_B]: { role: 'staff', permissions: { churn_radar: true } } }, active)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { whatsapp_templates: [
    { name: 'checkin', language: 'en', category: 'UTILITY', status: 'APPROVED', components: body('Hi {{1}}'), location_id: LOC_A },
    { name: 'promo', language: 'en', category: 'MARKETING', status: 'APPROVED', components: body('Sale'), location_id: LOC_A },
    { name: 'other_studio', language: 'en', category: 'UTILITY', status: 'APPROVED', components: body('Hey'), location_id: LOC_B },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/radar-outreach/templates', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it("403 'Forbidden' without churn_radar at the active studio, even with it elsewhere", async () => {
    getCurrentUser.mockResolvedValue(caller(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.calls).toEqual([])
  })

  it('lists the active studio’s approved utility templates only', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.templates.map((t) => t.name)).toEqual(['checkin'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    db.errors.whatsapp_templates = { select: { message: 'secret detail' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
