// ROUTEWRAP.R10 — PATCH/DELETE /api/admin/achievements/[id] through the real
// withAuth wrapper: signed out is the wrapper's 401, a non-master keeps the old
// 403 { ok: false, error: 'Forbidden' }, and a failed write answers a fixed
// message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH, DELETE } = await import('./route.js')

const RULE = 'a1000000-0000-4000-8000-0000000000a1'
const ctx = { params: Promise.resolve({ id: RULE }) }
const patch = (body) => PATCH(new Request(`http://localhost/api/admin/achievements/${RULE}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), ctx)
const del = () => DELETE(new Request(`http://localhost/api/admin/achievements/${RULE}`, { method: 'DELETE' }), ctx)
const owner = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const master = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { isMaster: true, profileRole: 'master' })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { achievement_rules: [{ id: RULE, slug: 'first', name: 'First' }] } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/admin/achievements/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch({ name: 'x' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 for an owner who is not a master, nothing written', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await patch({ name: 'Renamed' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Forbidden' })
    expect(db.tables.achievement_rules[0].name).toBe('First')
  })

  it('a master renames the rule', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await patch({ name: 'Renamed' })
    expect(res.status).toBe(200)
    expect((await res.json()).rule.name).toBe('Renamed')
  })

  it('a failed write answers a fixed message', async () => {
    db = createFakeDb({ tables: { achievement_rules: [{ id: RULE, slug: 'first', name: 'First' }] }, errors: { achievement_rules: { update: { message: 'constraint xyz' } } } })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(master)
    const res = await patch({ name: 'Renamed' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('xyz')
  })
})

describe('DELETE /api/admin/achievements/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del()).status).toBe(401)
  })

  it('403 for a non-master', async () => {
    getCurrentUser.mockResolvedValue(owner)
    expect((await del()).status).toBe(403)
    expect(db.tables.achievement_rules).toHaveLength(1)
  })

  it('a master deletes the rule', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await del()
    expect(await res.json()).toEqual({ ok: true })
    expect(db.tables.achievement_rules).toHaveLength(0)
  })
})
