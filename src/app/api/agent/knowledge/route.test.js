// RADAR-AGENT.0 — GET/POST /api/agent/knowledge through the real withAuth
// wrapper: reads and writes the active studio's entries; writes need a
// manager-tier role ('Forbidden' 403 otherwise).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const at = (role) => person({ [LOC_A]: { role } }, LOC_A)
const get = () => GET(new Request('http://localhost/api/agent/knowledge'))
const post = (body = { title: 'Opening hours', content: '6am to 9pm' }) => POST(new Request('http://localhost/api/agent/knowledge', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { agent_knowledge: [
    { id: 'a1000000-0000-4000-8000-000000000001', location_id: LOC_A, title: 'Ours', content: 'x', sort_order: 0 },
    { id: 'a1000000-0000-4000-8000-000000000002', location_id: LOC_B, title: 'Theirs', content: 'y', sort_order: 0 },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/agent/knowledge', () => {
  it('401 signed out (GET and POST)', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await get(), await post()]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
  })

  it('GET lists the active studio’s entries only', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).entries.map((e) => e.title)).toEqual(['Ours'])
  })

  it('POST 403 "Forbidden" for staff, nothing written', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.tables.agent_knowledge).toHaveLength(2)
  })

  it('POST by a manager writes at the active studio', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    const res = await post()
    expect(res.status).toBe(200)
    expect(db.tables.agent_knowledge.at(-1)).toMatchObject({ location_id: LOC_A, title: 'Opening hours', updated_by: 'user-1' })
  })

  it('a failed read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    db.errors.agent_knowledge = { select: { message: 'column agent_knowledge.x does not exist' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the knowledge entries.' })
  })
})
