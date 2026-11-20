// RCOV — re-hunt queue-patch semantics.
//
// The wedge this guards against: claim_recon_hunt_batch (mig 370) and
// the QStash worker's CAS (src/lib/recon/hunt-queue.js) only claim
// rows whose status is uncovered/not_found. A needs_attention line
// re-queued AS-IS is therefore queued-but-unclaimable — before the
// finalizer's own status-filtered pending gate, one click on Re-hunt
// wedged the weekly report + heartbeat forever. The patch must re-open
// a needs_attention line as 'uncovered' so the drain can actually
// claim it; uncovered/not_found lines keep their status (huntLine's
// own outcome moves them, unchanged).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { ALLOWED_FROM, rehuntPatch, POST } = await import('./route.js')

const NOW = '2026-07-19T12:00:00.000Z'

describe('ALLOWED_FROM', () => {
  it('permits exactly the operator-rehuntable states', () => {
    expect(ALLOWED_FROM).toEqual(['uncovered', 'not_found', 'needs_attention'])
  })
})

describe('rehuntPatch', () => {
  it('re-opens a needs_attention line as uncovered so the claim paths can drain it', () => {
    expect(rehuntPatch({ status: 'needs_attention' }, NOW)).toEqual({
      status: 'uncovered',
      hunt_queued_at: NOW,
      hunt_claimed_at: null,
      updated_at: NOW,
    })
  })

  it('leaves an uncovered line status untouched (huntLine outcome moves it)', () => {
    expect(rehuntPatch({ status: 'uncovered' }, NOW)).not.toHaveProperty('status')
  })

  it('leaves a not_found line status untouched', () => {
    expect(rehuntPatch({ status: 'not_found' }, NOW)).toEqual({
      hunt_queued_at: NOW,
      hunt_claimed_at: null,
      updated_at: NOW,
    })
  })
})

// POST through the real withAuth wrapper: accounting_hub at the active studio,
// line scoped to it (loadLineForCaller).
describe('POST /api/accounting/coverage/[id]/rehunt', () => {
  const L1 = 'e1000000-0000-4000-8000-000000000001'
  const L_OTHER = 'e1000000-0000-4000-8000-000000000002'
  const rows = () => [
    { id: L1, location_id: LOC_A, status: 'needs_attention', hunt_queued_at: null },
    { id: L_OTHER, location_id: LOC_B, status: 'uncovered', hunt_queued_at: null },
  ]
  const post = (id = L1) => POST(new Request(`http://localhost/api/accounting/coverage/${id}/rehunt`, { method: 'POST' }), { params: Promise.resolve({ id }) })
  const owner = () => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: true } } }, LOC_A)
  let db

  beforeEach(() => {
    vi.clearAllMocks()
    db = createFakeDb({ tables: { recon_bank_lines: rows() } })
    createServerClient.mockReturnValue(db)
  })

  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('403 "Forbidden" without accounting_hub, nothing queued', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff', permissions: { accounting_hub: false } } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(db.tables.recon_bank_lines[0].hunt_queued_at).toBeNull()
  })

  it('404 for a line at another studio', async () => {
    getCurrentUser.mockResolvedValue(owner())
    expect((await post(L_OTHER)).status).toBe(404)
    expect(db.tables.recon_bank_lines[1].hunt_queued_at).toBeNull()
  })

  it('an owner queues the line, re-opening a needs_attention one', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { queued: true } })
    expect(db.tables.recon_bank_lines[0].status).toBe('uncovered')
    expect(db.tables.recon_bank_lines[0].hunt_queued_at).toBeTruthy()
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(createFakeDb({ tables: { recon_bank_lines: rows() }, errors: { recon_bank_lines: { update: { message: 'secret detail' } } } }))
    const res = await post()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
