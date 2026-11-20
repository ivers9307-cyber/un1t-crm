// POST /api/teams/[id]/members through the real withAuth wrapper: races
// somewhere, body, the team, its studio (404 outside), races there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => null) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const TEAM = 'ec000000-0000-4000-8000-000000000001'
const TEAM_FAR = 'ec000000-0000-4000-8000-000000000002'
const post = (id, body = { name: 'New Member' }) => POST(new Request(`http://localhost/api/teams/${id}/members`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
const racesAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { races: a } }, [LOC_B]: { role: 'manager', permissions: { races: b } } }, LOC_A)
let db
const seed = (errors) => {
  db = createFakeDb({ tables: {
    teams: [{ id: TEAM, location_id: LOC_B, name: 'Here' }, { id: TEAM_FAR, location_id: LOC_OTHER, name: 'There' }],
    team_members: [],
  }, errors })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed() })

describe('POST /api/teams/[id]/members', () => {
  it('401 signed out, nobody added', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post(TEAM)).status).toBe(401)
    expect(db.tables.team_members).toHaveLength(0)
  })

  it('403 without races at the team\'s studio', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, false))
    expect((await post(TEAM)).status).toBe(403)
    expect(db.tables.team_members).toHaveLength(0)
  })

  it('404 for another studio\'s team', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    expect((await post(TEAM_FAR)).status).toBe(404)
  })

  it('adds the member', async () => {
    getCurrentUser.mockResolvedValue(racesAt(false, true))
    const res = await post(TEAM)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ name: 'New Member', role: 'member' })
  })

  it('a failed insert is a 400 without the database text', async () => {
    getCurrentUser.mockResolvedValue(racesAt(true, true))
    seed({ team_members: { insert: { message: 'secret detail' } } })
    const res = await post(TEAM)
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
