// SEQOUTCOME.1 — /api/sequences/[id]/outcomes through the real withAuth wrapper.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const SEQ_A = '5e000000-0000-4000-8000-00000000000a'
const SEQ_B = '5e000000-0000-4000-8000-00000000000b'
const MANAGER_A = person({ [LOC_A]: { role: 'manager', permissions: { email: true } } }, LOC_A)
const STAFF_A = person({ [LOC_A]: { role: 'staff', permissions: { email: true } } }, LOC_A)
const call = (id) => GET(new Request(`http://localhost/api/sequences/${id}/outcomes`), { params: Promise.resolve({ id }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { email_sequences: [{ id: SEQ_A, location_id: LOC_A }, { id: SEQ_B, location_id: LOC_B }] } })
  db.rpc = vi.fn(async () => ({ data: [
    { cohort: 'clicked', contacts: '10', event_registrations: '1', class_attendances: '4', purchases: '2', purchase_cents: '5000' },
    { cohort: 'not_opened', contacts: '20', event_registrations: '0', class_attendances: '1', purchases: '0', purchase_cents: '0' },
  ], error: null }))
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
})

describe('GET /api/sequences/[id]/outcomes', () => {
  it('returns both cohorts as numbers', async () => {
    const res = await call(SEQ_A)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.clicked).toEqual({ contacts: 10, event_registrations: 1, class_attendances: 4, purchases: 2, purchase_cents: 5000 })
    expect(body.data.not_opened.contacts).toBe(20)
    expect(db.rpc).toHaveBeenCalledWith('sequence_outcome_stats', { p_sequence_id: SEQ_A, p_window_days: 7 })
  })

  it("404s for another studio's automation", async () => {
    expect((await call(SEQ_B)).status).toBe(404)
  })

  it('refuses staff below manager', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await call(SEQ_A)).status).toBe(403)
  })
})
