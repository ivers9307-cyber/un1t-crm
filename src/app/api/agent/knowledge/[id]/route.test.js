// PUT/DELETE /api/agent/knowledge/[id] through the real withAuth wrapper: the
// coarse manager check, the row's studio and MANAGER_ROLES there run in the
// handler in their old order (tests/role-sweep/automations-and-settings.test.js
// holds the full role table).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PUT, DELETE } = await import('./route.js')

const KB = 'e8000000-0000-4000-8000-000000000001'
const KB_ELSEWHERE = 'e8000000-0000-4000-8000-000000000002'
const props = (id) => ({ params: Promise.resolve({ id }) })
const put = (id, body) => PUT(new Request(`http://localhost/api/agent/knowledge/${id}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), props(id))
const del = (id) => DELETE(new Request(`http://localhost/api/agent/knowledge/${id}`, { method: 'DELETE' }), props(id))
const managerAtB = () => person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A)
let db
const seed = (errors) => {
  db = createFakeDb({ tables: { agent_knowledge: [
    { id: KB, location_id: LOC_B, category: 'hours', title: 'Old', content: '', enabled: true, sort_order: 0 },
    { id: KB_ELSEWHERE, location_id: LOC_OTHER, category: 'hours', title: 'Theirs', content: '', enabled: true, sort_order: 0 },
  ] }, errors })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed() })

describe('PUT /api/agent/knowledge/[id]', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await put(KB, { title: 'New' })).status).toBe(401)
    expect(db.tables.agent_knowledge[0].title).toBe('Old')
  })

  it('403 for staff everywhere', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'staff' } }, LOC_B))
    expect((await put(KB, { title: 'New' })).status).toBe(403)
  })

  it('refuses another studio\'s row and leaves it alone', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    expect((await put(KB_ELSEWHERE, { title: 'New' })).status).toBe(403)
    expect(db.tables.agent_knowledge[1].title).toBe('Theirs')
  })

  it('a manager at the row\'s studio saves it', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    const res = await put(KB, { title: '  New  ' })
    expect(res.status).toBe(200)
    expect((await res.json()).entry).toMatchObject({ id: KB, title: 'New' })
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    seed({ agent_knowledge: { update: { message: 'secret detail' } } })
    const res = await put(KB, { title: 'New' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

describe('DELETE /api/agent/knowledge/[id]', () => {
  it('401 signed out, nothing deleted', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del(KB)).status).toBe(401)
    expect(db.tables.agent_knowledge).toHaveLength(2)
  })

  it('a manager at the row\'s studio deletes it', async () => {
    getCurrentUser.mockResolvedValue(managerAtB())
    expect((await del(KB)).status).toBe(200)
    expect(db.tables.agent_knowledge.map((r) => r.id)).toEqual([KB_ELSEWHERE])
  })
})
