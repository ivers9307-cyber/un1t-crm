// HATCHPIPE.2 — include_disabled reaches the orchestrator only on a dry run.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ fake: 'db' })) }))
vi.mock('@/lib/pipeline-reclassify', () => ({ reclassifyAllContacts: vi.fn(), restampUn1tDealDates: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { reclassifyAllContacts, restampUn1tDealDates } = await import('@/lib/pipeline-reclassify')
const { POST } = await import('./route.js')

const LOC = 'a0000000-0000-0000-0000-00000000000b'
const req = (body) => new Request('http://test/api/admin/pipeline-reclassify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'master-1', profileRole: 'master' })
  reclassifyAllContacts.mockResolvedValue({ ok: true })
})

describe('POST /api/admin/pipeline-reclassify — include_disabled', () => {
  it('passes includeDisabled with dry_run', async () => {
    const res = await POST(req({ location_id: LOC, dry_run: true, include_disabled: ['acquisition'] }))
    expect(res.status).toBe(200)
    expect(reclassifyAllContacts).toHaveBeenCalledWith({ fake: 'db' }, expect.objectContaining({
      locationId: LOC, dryRun: true, includeDisabled: ['acquisition'],
    }))
  })

  it('drops include_disabled on a real run', async () => {
    const res = await POST(req({ location_id: LOC, include_disabled: ['acquisition'] }))
    expect(res.status).toBe(200)
    const args = reclassifyAllContacts.mock.calls[0][1]
    expect(args.dryRun).toBe(false)
    expect(args).not.toHaveProperty('includeDisabled')
  })

  it('refuses a key other than acquisition', async () => {
    const res = await POST(req({ location_id: LOC, dry_run: true, include_disabled: ['waitlist'] }))
    expect(res.status).toBe(400)
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
  })
})

// HATCHPIPE.5 — restamp_dates goes to the backfill, never the classifier.
describe('POST /api/admin/pipeline-reclassify — restamp_dates routing', () => {
  it('restamp_dates calls restampUn1tDealDates with the location and dry run, and never reclassifies', async () => {
    restampUn1tDealDates.mockResolvedValue({ ok: true, updated: 0 })
    const res = await POST(req({ location_id: LOC, restamp_dates: true, dry_run: true }))
    expect(res.status).toBe(200)
    expect(restampUn1tDealDates).toHaveBeenCalledWith({ fake: 'db' }, { locationId: LOC, dryRun: true })
    expect(reclassifyAllContacts).not.toHaveBeenCalled()
  })

  it('a failed restamp is a 500 carrying its answer', async () => {
    restampUn1tDealDates.mockResolvedValue({ ok: false, error: 'un1t inputs unavailable: unknown' })
    const res = await POST(req({ location_id: LOC, restamp_dates: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('un1t inputs unavailable: unknown')
  })

  it('restamp_dates false is an ordinary reclassify', async () => {
    const res = await POST(req({ location_id: LOC, restamp_dates: false }))
    expect(res.status).toBe(200)
    expect(reclassifyAllContacts).toHaveBeenCalledTimes(1)
    expect(restampUn1tDealDates).not.toHaveBeenCalled()
  })
})
