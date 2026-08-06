import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))
vi.mock('@/lib/zoom/reconcile', () => ({ runZoomContactSync: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { POST } from './route'

const post = (body) => new Request('https://x.test/api/integrations/zoom-contacts/run', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const userIn = (orgId = 'org-1') => ({
  id: 'u-1', isMaster: false,
  rolesByLocation: { 'loc-1': 'manager' },
  activeOrganization: { id: orgId },
})

beforeEach(() => {
  process.env.ZOOM_SYNC_ORGANIZATION_ID = 'org-1'
  // mockClear on all three — without it, mock.calls accumulates across tests
  // in this file (vitest does not auto-clear mocks between tests) and
  // `.mock.calls[0]` / `.not.toHaveBeenCalled()` below stop meaning "the call
  // this test just made" (same rationale as the cron route's sibling test).
  vi.mocked(getCurrentUser).mockClear()
  vi.mocked(hasPermission).mockClear()
  vi.mocked(runZoomContactSync).mockClear()
  vi.mocked(getCurrentUser).mockResolvedValue(userIn())
  vi.mocked(hasPermission).mockReturnValue(true)   // default: permitted
  vi.mocked(runZoomContactSync).mockResolvedValue({ ok: true, counts: { creates: 1, updates: 0, deletes: 0 }, enqueued: 1 })
})

describe('POST /api/integrations/zoom-contacts/run', () => {
  it('401s when unauthenticated', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    expect((await POST(post({ dry: true }))).status).toBe(401)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // A preview writes nothing, so it must NOT consult the permission key.
  it('lets an unprivileged user preview', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const res = await POST(post({ dry: true }))
    expect(res.status).toBe(200)
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0]).toMatchObject({ dry: true, trigger: 'manual', triggeredBy: 'u-1' })
  })

  it('refuses a real run without the permission', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    expect((await POST(post({ dry: false }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // force is destructive even alongside dry — it must never ride in on the
  // preview exemption.
  it('refuses the guard override without the permission, even with dry set', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    expect((await POST(post({ dry: true, force: true }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  it('checks the right permission key', async () => {
    await POST(post({ force: true }))
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'integrations_zoom_manage')
  })

  it('lets a permitted user run and force', async () => {
    expect((await POST(post({ force: true }))).status).toBe(200)
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].force).toBe(true)
  })

  it('refuses a user outside the synced organisation even with the permission', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userIn('org-other'))
    expect((await POST(post({ dry: true }))).status).toBe(403)
  })

  it('400s on a bad limit', async () => {
    expect((await POST(post({ limit: -5 }))).status).toBe(400)
  })

  it('redacts the guard sample for a caller who cannot act on it', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111', '+353872222222'] },
    })
    const body = await (await POST(post({ dry: true }))).json()
    expect(body.data.guard.sample).toBeUndefined()
    expect(body.data.guard.sampleRedacted).toBe(2)
    expect(body.data.guard.attempted).toBe(400)   // counts still useful
  })

  it('gives the sample to a caller who can act on it', async () => {
    vi.mocked(runZoomContactSync).mockResolvedValue({
      ok: false, guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111'] },
    })
    const body = await (await POST(post({ dry: true }))).json()
    expect(body.data.guard.sample).toEqual(['+353871111111'])
  })
})
