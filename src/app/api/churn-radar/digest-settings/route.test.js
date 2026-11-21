// GET/PUT /api/churn-radar/digest-settings through the real withAuth wrapper:
// signed in, then by hand: churn_radar at the active studio 403 'Forbidden',
// an active studio 400; the recipients live on that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, PUT } = await import('./route.js')

const put = (body) => PUT(new Request('http://localhost/api/churn-radar/digest-settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const radarAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { churn_radar: a } }, [LOC_B]: { role: 'owner', permissions: { churn_radar: b } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { locations: [
    { id: LOC_A, churn_digest_recipients: ['a@example.com'] },
    { id: LOC_B, churn_digest_recipients: ['b@example.com'] },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/churn-radar/digest-settings', () => {
  it('401 signed out (withAuth), nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
    expect((await put({ recipients: [] })).status).toBe(401)
    expect(db.tables.locations[0].churn_digest_recipients).toEqual(['a@example.com'])
  })

  it('403 without churn_radar at the active studio, even with it elsewhere', async () => {
    getCurrentUser.mockResolvedValue(radarAt(false, true))
    const res = await put({ recipients: [] })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('400 with no active studio, in its old words', async () => {
    getCurrentUser.mockResolvedValue({ ...radarAt(true, true), activeLocation: null })
    const res = await GET()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No active location' })
  })

  it('reads and saves the active studio\'s list only', async () => {
    getCurrentUser.mockResolvedValue(radarAt(true, false))
    expect(await (await GET()).json()).toEqual({ success: true, data: { recipients: ['a@example.com'] } })
    const res = await put({ recipients: [' New@Example.com ', 'new@example.com'] })
    expect(res.status).toBe(200)
    expect(db.tables.locations.map((l) => l.churn_digest_recipients)).toEqual([['new@example.com'], ['b@example.com']])
  })
})
