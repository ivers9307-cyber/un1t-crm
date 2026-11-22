// ROUTEWRAP.R16 — GET/POST /api/sequences through the real withAuth wrapper:
// signed in (the same 401), the builder rule (email or whatsapp) somewhere and
// at the studio named (403), another studio refused, the list scoped.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')

const SEQ_A = 'c4000000-0000-4000-8000-0000000000a1'
const SEQ_B = 'c4000000-0000-4000-8000-0000000000b1'
const SEQ_FAR = 'c4000000-0000-4000-8000-0000000000f1'
const get = (q = '') => GET(new Request(`http://localhost/api/sequences${q}`))
const post = (body) => POST(new Request('http://localhost/api/sequences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const builderAt = (a, b) => person({ [LOC_A]: { role: 'manager', permissions: { email: a, whatsapp: false } }, [LOC_B]: { role: 'manager', permissions: { email: b, whatsapp: false } } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { email_sequences: [
    { id: SEQ_A, location_id: LOC_A, name: 'A', status: 'draft', created_at: '2026-11-01T00:00:00Z' },
    { id: SEQ_B, location_id: LOC_B, name: 'B', status: 'draft', created_at: '2026-11-02T00:00:00Z' },
    { id: SEQ_FAR, location_id: LOC_OTHER, name: 'Far', status: 'draft', created_at: '2026-11-03T00:00:00Z' },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/sequences', () => {
  it('401 signed out, both methods', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ success: false, error: 'Unauthorized' })
    expect((await post({ name: 'x' })).status).toBe(401)
  })

  it('403 without email or whatsapp anywhere; 403 at a studio without it', async () => {
    getCurrentUser.mockResolvedValue(builderAt(false, false))
    expect((await get()).status).toBe(403)
    getCurrentUser.mockResolvedValue(builderAt(true, false))
    expect((await get(`?location_id=${LOC_B}`)).status).toBe(403)
    expect((await post({ name: 'x', location_id: LOC_B })).status).toBe(403)
  })

  it('another studio is refused, nothing created', async () => {
    getCurrentUser.mockResolvedValue(builderAt(true, true))
    expect((await get(`?location_id=${LOC_OTHER}`)).status).toBe(403)
    expect((await post({ name: 'x', location_id: LOC_OTHER })).status).toBe(403)
    expect(db.tables.email_sequences).toHaveLength(3)
  })

  it('the unscoped list holds only studios where the caller may build', async () => {
    getCurrentUser.mockResolvedValue(builderAt(true, false))
    const body = await (await get()).json()
    expect(body.sequences.map((s) => s.id)).toEqual([SEQ_A])
  })

  it('creates a draft at the active studio', async () => {
    getCurrentUser.mockResolvedValue(builderAt(true, false))
    const res = await post({ name: 'Welcome' })
    expect(res.status).toBe(200)
    expect((await res.json()).sequence).toMatchObject({ name: 'Welcome', location_id: LOC_A, status: 'draft' })
  })

  it('SECGAPS.1 — a webhook sequence is created with a token, but the answer never carries it', async () => {
    getCurrentUser.mockResolvedValue(builderAt(true, false))
    const res = await post({ name: 'Hook', trigger_type: 'webhook' })
    expect(res.status).toBe(200)
    const { sequence } = await res.json()
    expect(sequence.id).toBeTruthy()
    expect(sequence).not.toHaveProperty('webhook_token')
    expect(sequence).not.toHaveProperty('webhook_secret')
    expect(sequence).not.toHaveProperty('created_by')
    const stored = db.tables.email_sequences.find((r) => r.id === sequence.id)
    expect(stored.webhook_token).toMatch(/^[0-9a-f]{32}$/)
  })
})
