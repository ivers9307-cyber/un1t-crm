// RCOV — GET /api/accounting/coverage through the real withAuth wrapper:
// accounting_hub at the active studio, lines and counts of that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const hub = (on) => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: on } } }, LOC_A)
const get = (qs = '') => GET(new Request(`http://localhost/api/accounting/coverage${qs}`))
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    recon_bank_lines: [
      { id: 'b1000000-0000-4000-8000-000000000001', location_id: LOC_A, status: 'uncovered', line_date: '2026-11-01', amount: 10 },
      { id: 'b1000000-0000-4000-8000-000000000002', location_id: LOC_B, status: 'uncovered', line_date: '2026-11-02', amount: 20 },
    ],
    recon_runs: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/accounting/coverage', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without accounting_hub, nothing read', async () => {
    getCurrentUser.mockResolvedValue(hub(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.calls).toEqual([])
  })

  it('lists and counts the active studio’s lines only', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    const res = await get()
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.lines.map((l) => l.amount)).toEqual([10])
    expect(data.counts.uncovered).toBe(1)
  })

  it('a failed read answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    db.errors.recon_bank_lines = { select: { message: 'relation recon_bank_lines is broken' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not load the bank lines.' })
  })
})
