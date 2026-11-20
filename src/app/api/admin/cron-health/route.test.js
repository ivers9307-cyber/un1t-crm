// STALEWATCH.1 — GET /api/admin/cron-health through the real withAuth wrapper:
// masters only (profiles.role); the heartbeats come back ordered by name.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/admin/cron-health'))
const tables = () => ({ cron_health: [{ name: 'b-job', is_stale: false }, { name: 'a-job', is_stale: true }] })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: tables() }))
})

describe('GET /api/admin/cron-health', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 for an owner who is not a master', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('a master gets every heartbeat, ordered by name', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((r) => r.name)).toEqual(['a-job', 'b-job'])
  })

  it('a failed read is a 503 with a fixed line', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: tables(), errors: { cron_health: { select: { message: 'relation exploded' } } } }))
    const res = await get()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('Could not read the job heartbeats.')
  })
})
