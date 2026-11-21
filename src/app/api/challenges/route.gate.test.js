// /api/challenges and /api/challenges/[id] through the real withAuth wrapper:
// a signed-out call is withAuth's 401 (they said 'Unauthorised' before), the
// coarse role and feature checks keep their texts, another studio's challenge
// is a 404 and nothing is written, and database text never reaches a response.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/host-brand', async (importOriginal) => ({ ...(await importOriginal()), resolveLocationBrand: vi.fn(async () => ({ shortName: 'UN1T' })) }))
vi.mock('@/lib/location-time', async (importOriginal) => ({ ...(await importOriginal()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const list = await import('./route.js')
const one = await import('./[id]/route.js')

const CH_A = 'c4000000-0000-4000-8000-00000000000a'
const CH_B = 'c4000000-0000-4000-8000-00000000000b'
const MANAGER_A = person({ [LOC_A]: { role: 'manager', permissions: { challenges: true } } }, LOC_A)
const STAFF_A = person({ [LOC_A]: { role: 'staff', permissions: { challenges: true } } }, LOC_A)
const json = (method, body) => new Request('http://localhost/api/challenges', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const props = (id) => ({ params: Promise.resolve({ id }) })
const row = (id, loc) => ({ id, location_id: loc, name: 'Nov', mode: 'individual', metric: 'points', starts_on: '2099-01-01', ends_on: '2099-01-31', target: null, is_flagship: false })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { challenges: [row(CH_A, LOC_A), row(CH_B, LOC_B)] } })
  createServerClient.mockReturnValue(db)
})

describe('challenges routes on withAuth', () => {
  it('401 signed out on every method, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [
      await list.GET(new Request('http://localhost/api/challenges')),
      await list.POST(json('POST', {})),
      await one.PUT(json('PUT', { name: 'x' }), props(CH_A)),
      await one.DELETE(new Request('http://localhost/api/challenges/x', { method: 'DELETE' }), props(CH_A)),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
    expect(db.tables.challenges.map((c) => c.name)).toEqual(['Nov', 'Nov'])
  })

  it('403 Manager+ required for staff', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const res = await list.GET(new Request('http://localhost/api/challenges'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect((await one.DELETE(new Request('http://localhost/x', { method: 'DELETE' }), props(CH_A))).status).toBe(403)
  })

  it('404 for another studio’s challenge, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await one.PUT(json('PUT', { name: 'Taken' }), props(CH_B))).status).toBe(404)
    expect((await one.DELETE(new Request('http://localhost/x', { method: 'DELETE' }), props(CH_B))).status).toBe(404)
    expect(db.tables.challenges[1].name).toBe('Nov')
  })

  it('the list is the caller’s own studio only; an edit and a delete land', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const body = await (await list.GET(new Request('http://localhost/api/challenges'))).json()
    expect(body.data.map((c) => c.id)).toEqual([CH_A])
    expect((await one.PUT(json('PUT', { name: 'December' }), props(CH_A))).status).toBe(200)
    expect(db.tables.challenges[0].name).toBe('December')
    expect((await one.DELETE(new Request('http://localhost/x', { method: 'DELETE' }), props(CH_A))).status).toBe(200)
    expect(db.tables.challenges.map((c) => c.id)).toEqual([CH_B])
  })

  it('a failed write answers a fixed message, never the database text', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    db.errors.challenges = { update: { message: 'duplicate key value violates unique constraint "challenges_pkey"' }, delete: { message: 'fk violation on challenge_entries' } }
    const put = await one.PUT(json('PUT', { name: 'x' }), props(CH_A))
    expect(await put.json()).toEqual({ success: false, error: 'Could not save the challenge. Try again.' })
    const del = await one.DELETE(new Request('http://localhost/x', { method: 'DELETE' }), props(CH_A))
    expect(await del.json()).toEqual({ success: false, error: 'Could not delete the challenge. Try again.' })
  })
})
