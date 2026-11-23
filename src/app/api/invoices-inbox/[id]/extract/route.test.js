// INVOICEPREP.3 — POST /api/invoices-inbox/[id]/extract ("Read again") through
// the real withAuth wrapper: the row gate (loadInvoiceForCaller, every refusal
// a 404), a claim so the background queue cannot read the row at the same
// time, then prepareInvoiceRow with force.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/invoices-queue/prepare', () => ({ prepareInvoiceRow: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { prepareInvoiceRow } = await import('@/lib/invoices-queue/prepare')
const { CLAIM_STALE_MINUTES } = await import('@/lib/invoice-analysis-queue')
const { POST, maxDuration } = await import('./route.js')

const INV = 'c2000000-0000-4000-8000-000000000001'
const INV_B = 'c2000000-0000-4000-8000-000000000002'
const row = (extra = {}) => ({
  id: INV, location_id: LOC_A, status: 'received',
  attachment_bucket: 'inbound-invoices', attachment_path: 'inv/one.pdf',
  review_reasons: [], analysis_claimed_at: null, analysis_queued_at: null,
  ...extra,
})
const post = (id = INV) => POST(new Request(`http://localhost/api/invoices-inbox/${id}/extract`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const ownerA = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()
let db
const mine = () => db.tables.invoices_queue[0]

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    invoices_queue: [row(), row({ id: INV_B, location_id: LOC_B })],
    locations: [{ id: LOC_A, name: 'A' }, { id: LOC_B, name: 'B' }],
  } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(ownerA())
  // Stands in for a successful read: preparation clears its own claim.
  prepareInvoiceRow.mockImplementation(async (_db, r) => {
    Object.assign(mine(), { status: 'extracted', review_reasons: [], analysis_claimed_at: null, analysis_queued_at: null })
    return { outcome: 'prepared', reasons: [], seen: r }
  })
})

describe('POST /api/invoices-inbox/[id]/extract', () => {
  it('allows a long read', () => {
    expect(maxDuration).toBeGreaterThanOrEqual(120)
  })

  it('from received: claims the row, then prepares it with force', async () => {
    let atCall
    prepareInvoiceRow.mockImplementationOnce(async (_db, r, deps) => {
      atCall = { row: r, deps, stored: { ...mine() } }
      Object.assign(mine(), { status: 'extracted', analysis_claimed_at: null, analysis_queued_at: null })
      return { outcome: 'prepared', reasons: [] }
    })
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, outcome: 'prepared', data: { id: INV, status: 'extracted' } })
    expect(atCall.deps).toEqual({ force: true })
    expect(atCall.row).toMatchObject({ id: INV, status: 'received', location_id: LOC_A, attachment_path: 'inv/one.pdf' })
    expect(atCall.stored.analysis_claimed_at).toBeTruthy()
    expect(atCall.stored.analysis_queued_at).toBeTruthy()
  })

  it('from extracted: moves the row back to quality_approved with empty reasons first', async () => {
    Object.assign(mine(), {
      status: 'extracted', review_reasons: ['duplicate_number'],
      duplicate_of_id: INV_B, extraction_error: 'old',
    })
    let seen
    prepareInvoiceRow.mockImplementationOnce(async (_db, r) => {
      seen = r
      return { outcome: 'prepared', reasons: [] }
    })
    expect((await post()).status).toBe(200)
    expect(seen).toMatchObject({ status: 'quality_approved', review_reasons: [], duplicate_of_id: null, extraction_error: null })
  })

  it('a fresh claim answers 409 and never reads', async () => {
    mine().analysis_claimed_at = minutesAgo(1)
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This invoice is being read right now. Try again in a moment.')
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('a stale claim is taken over', async () => {
    const stale = minutesAgo(CLAIM_STALE_MINUTES + 5)
    mine().analysis_claimed_at = stale
    let claimedAt
    prepareInvoiceRow.mockImplementationOnce(async () => {
      claimedAt = mine().analysis_claimed_at
      return { outcome: 'prepared', reasons: [] }
    })
    expect((await post()).status).toBe(200)
    expect(claimedAt).not.toBe(stale)
    expect(new Date(claimedAt).getTime()).toBeGreaterThan(new Date(stale).getTime())
  })

  it('an unreadable file answers 422 with the stored error and the row', async () => {
    prepareInvoiceRow.mockImplementationOnce(async () => {
      Object.assign(mine(), { review_reasons: ['unreadable'], extraction_error: 'download: unknown', analysis_claimed_at: null })
      return { outcome: 'unreadable', reasons: ['unreadable'] }
    })
    const res = await post()
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'download: unknown', data: { id: INV } })
  })

  it('a skipped preparation answers 409', async () => {
    prepareInvoiceRow.mockResolvedValueOnce({ outcome: 'skipped', reasons: [] })
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Row was modified concurrently — refresh and retry.')
  })

  it('a throwing preparation answers 500 and lets go of the claim', async () => {
    prepareInvoiceRow.mockRejectedValueOnce(new Error('boom'))
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the invoice. Try again.' })
    expect(mine().analysis_claimed_at).toBeNull()
    expect(mine().analysis_queued_at).toBeNull()
  })

  it('404 for another studio’s invoice, nothing claimed', async () => {
    const res = await post(INV_B)
    expect(res.status).toBe(404)
    expect(db.tables.invoices_queue[1].analysis_claimed_at).toBeNull()
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('404 for a manager at the studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager', permissions: { invoices_inbox: true } } }, LOC_A))
    expect((await post()).status).toBe(404)
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('409 for a forwarded row', async () => {
    mine().status = 'forwarded'
    expect((await post()).status).toBe(409)
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })

  it('400 for a row with no file', async () => {
    mine().attachment_path = null
    expect((await post()).status).toBe(400)
    expect(prepareInvoiceRow).not.toHaveBeenCalled()
  })
})
