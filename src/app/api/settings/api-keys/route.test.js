// ROUTEWRAP.R10 — GET/POST /api/settings/api-keys through the real withAuth
// wrapper: signed out is the wrapper's 401, only an admin of the active
// organisation lists or mints keys (403 'forbidden' otherwise), the list never
// carries a hash, and a failed read answers a fixed message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const OTHER_ORG = 'e0000000-0000-4000-8000-0000000000e0'
const owner = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const admin = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { orgAdminOrgIds: [ORG] })
const post = (body) => POST(new Request('http://localhost/api/settings/api-keys', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
let db
const seed = (errors) => createFakeDb({
  tables: {
    api_keys: [
      { id: 'a0000000-0000-4000-8000-000000000001', organization_id: ORG, name: 'Ours', key_prefix: 'unitk_ab', key_hash: 'h1', created_at: '2026-11-01T00:00:00Z' },
      { id: 'a0000000-0000-4000-8000-000000000002', organization_id: OTHER_ORG, name: 'Theirs', key_prefix: 'unitk_cd', key_hash: 'h2', created_at: '2026-11-02T00:00:00Z' },
    ],
  },
  errors,
})

beforeEach(() => {
  vi.clearAllMocks()
  db = seed()
  createServerClient.mockImplementation(() => db)
})

describe('/api/settings/api-keys', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await GET(new Request('http://localhost/api/settings/api-keys')), await post({ name: 'x' })]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
  })

  it('403 for a studio owner who is not an organisation admin, nothing minted', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await post({ name: 'x' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'forbidden' })
    expect(db.tables.api_keys).toHaveLength(2)
  })

  it('lists only the organisation’s keys, without hashes', async () => {
    getCurrentUser.mockResolvedValue(admin)
    const body = await (await GET(new Request('http://localhost/api/settings/api-keys'))).json()
    expect(body.keys.map((k) => k.name)).toEqual(['Ours'])
    expect(JSON.stringify(body)).not.toContain('h1')
  })

  it('mints a key for the organisation and shows the secret once', async () => {
    getCurrentUser.mockResolvedValue(admin)
    const res = await post({ name: 'Zapier' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.secret).toMatch(/^unitk_/)
    expect(db.tables.api_keys.at(-1)).toMatchObject({ organization_id: ORG, name: 'Zapier', created_by: 'user-1' })
  })

  it('a failed read answers a fixed message', async () => {
    db = seed({ api_keys: { select: { message: 'permission denied xyz' } } })
    getCurrentUser.mockResolvedValue(admin)
    const res = await GET(new Request('http://localhost/api/settings/api-keys'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('xyz')
  })
})
