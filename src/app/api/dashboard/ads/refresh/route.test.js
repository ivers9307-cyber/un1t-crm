// POST /api/dashboard/ads/refresh through the real withAuth wrapper: the body's
// studio must be one of the caller's (403) with dashboard_ads there (403); a
// provider failure is answered with a fixed line, its text kept on the account.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/ads/sync', () => ({ syncAccount: vi.fn() }))
vi.mock('@/lib/ads/providers/meta', () => ({ name: 'meta' }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { syncAccount } = await import('@/lib/ads/sync')
const { POST } = await import('./route.js')

const ACC = 'e0000000-0000-4000-8000-0000000000a1'
const post = (body) => POST(new Request('http://localhost/api/dashboard/ads/refresh', { method: 'POST', body: JSON.stringify(body) }))
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { dashboard_ads: a } }, [LOC_B]: { role: 'owner', permissions: { dashboard_ads: b } } }, LOC_A)
let db

beforeEach(() => {
  vi.clearAllMocks()
  syncAccount.mockResolvedValue(undefined)
  db = createFakeDb({
    tables: {
      ad_accounts: [{ id: ACC, location_id: LOC_B, provider: 'meta', external_account_id: 'act_1', is_active: true, account_timezone: 'Europe/Dublin' }],
      locations: [{ id: LOC_B, timezone: 'Europe/Dublin' }],
    },
  })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/dashboard/ads/refresh', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ locationId: LOC_B })).status).toBe(401)
  })

  it('400 without a locationId', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({})).status).toBe(400)
  })

  it('403 for a studio the caller is not in, and 403 "Forbidden" without dashboard_ads there', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({ locationId: LOC_OTHER })).status).toBe(403)
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await post({ locationId: LOC_B })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(syncAccount).not.toHaveBeenCalled()
  })

  it('an allowed caller syncs that studio\'s accounts', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    const res = await post({ locationId: LOC_B })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, results: [{ id: ACC, ok: true }] })
    expect(typeof body.synced_at).toBe('string')
  })

  it('a provider failure shows the operator the provider message and keeps it on the account', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    syncAccount.mockRejectedValue(new Error('Error validating access token: Session has expired'))
    const res = await post({ locationId: LOC_B })
    const body = await res.json()
    // The operator needs Meta's own words (an expired token) to know what to fix.
    expect(body.results).toEqual([{ id: ACC, error: 'Error validating access token: Session has expired' }])
    expect(db.tables.ad_accounts[0].last_sync_error).toBe('Error validating access token: Session has expired')
  })
})
