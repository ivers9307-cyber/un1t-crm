// HATCHPIPE.2 — include_disabled reaches the orchestrator only on a dry run.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ fake: 'db' })) }))
vi.mock('@/lib/pipeline-reclassify', () => ({ reclassifyAllContacts: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { reclassifyAllContacts } = await import('@/lib/pipeline-reclassify')
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
