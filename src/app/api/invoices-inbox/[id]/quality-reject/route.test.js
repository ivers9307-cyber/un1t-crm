// INVOICES.1 — the stage-1 and stage-2 reject routes through the real withAuth
// wrapper, with loadInvoiceForUser's own gate (owner/master + invoices_inbox
// at the row's studio, 404 otherwise) still deciding.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const quality = await import('./route.js')
const data = await import('../data-reject/route.js')

const INV = 'e0000000-0000-4000-8000-000000000001'
let db
const call = (mod, reason = 'Not an invoice') => mod.POST(
  new Request(`http://localhost/api/invoices-inbox/${INV}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }),
  { params: Promise.resolve({ id: INV }) },
)
const owner = (loc) => person({ [loc]: { role: 'owner', permissions: { invoices_inbox: true } } }, loc)
const seed = (status, location_id = LOC_A, extra = {}) => {
  db = createFakeDb({ tables: {
    locations: [{ id: LOC_A, name: 'A' }, { id: LOC_B, name: 'B' }],
    invoices_queue: [{ id: INV, location_id, status, ...extra }],
  } })
  createServerClient.mockReturnValue(db)
}

beforeEach(() => { vi.clearAllMocks(); seed('received') })

describe.each([
  ['quality-reject', quality, 'received', 'quality'],
  ['data-reject', data, 'extracted', 'data'],
])('POST /api/invoices-inbox/[id]/%s', (_name, mod, from, stage) => {
  beforeEach(() => seed(from))

  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call(mod)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.invoices_queue[0].status).toBe(from)
  })

  it('404 for an owner of another studio', async () => {
    getCurrentUser.mockResolvedValue(owner(LOC_B))
    expect((await call(mod)).status).toBe(404)
    expect(db.tables.invoices_queue[0].status).toBe(from)
  })

  it('404 for a manager with invoices_inbox (the sign-off is owner/master)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { invoices_inbox: true } } }, LOC_A))
    expect((await call(mod)).status).toBe(404)
  })

  it('the owner rejects it, stamped as the caller', async () => {
    getCurrentUser.mockResolvedValue(owner(LOC_A))
    const res = await call(mod)
    expect(res.status).toBe(200)
    expect(db.tables.invoices_queue[0]).toMatchObject({ status: 'rejected', rejected_stage: stage, reject_reason: 'Not an invoice', [`${stage}_reviewed_by`]: 'user-1' })
  })

  it('a failed write is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.invoices_queue = { update: { message: 'secret detail' } }
    const res = await call(mod)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

describe('POST /api/invoices-inbox/[id]/quality-reject — flagged rows a person cannot otherwise clear', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(owner(LOC_A)))

  it.each([['unreadable'], ['duplicate_file']])('rejects a quality_approved row flagged %s', async (reason) => {
    seed('quality_approved', LOC_A, { review_reasons: [reason], analysis_queued_at: '2026-11-22T10:00:00Z', analysis_claimed_at: '2026-11-22T10:00:01Z' })
    const res = await call(quality)
    expect(res.status).toBe(200)
    expect(db.tables.invoices_queue[0]).toMatchObject({
      status: 'rejected', rejected_stage: 'quality', analysis_queued_at: null, analysis_claimed_at: null,
    })
  })

  it('refuses a quality_approved row with no such flag', async () => {
    seed('quality_approved', LOC_A, { review_reasons: [] })
    const res = await call(quality)
    expect(res.status).toBe(409)
    expect(db.tables.invoices_queue[0].status).toBe('quality_approved')
  })

  it('a received reject clears the queue columns too', async () => {
    seed('received', LOC_A, { analysis_queued_at: '2026-11-22T10:00:00Z', analysis_claimed_at: '2026-11-22T10:00:01Z' })
    expect((await call(quality)).status).toBe(200)
    expect(db.tables.invoices_queue[0]).toMatchObject({ status: 'rejected', analysis_queued_at: null, analysis_claimed_at: null })
  })

  it('a row that moved on after it was read answers 409, not 500', async () => {
    seed('quality_approved', LOC_A, { review_reasons: ['unreadable'] })
    // The gate reads quality_approved; by the write the row has been read.
    const realFrom = db.from.bind(db)
    let reads = 0
    db.from = (t) => {
      const b = realFrom(t)
      if (t === 'invoices_queue' && reads++ === 0) {
        const orig = b.then.bind(b)
        b.then = (res, rej) => orig((r) => { db.tables.invoices_queue[0].status = 'extracted'; return res(r) }, rej)
      }
      return b
    }
    const res = await call(quality)
    expect(res.status).toBe(409)
    expect(db.tables.invoices_queue[0].status).toBe('extracted')
  })
})
