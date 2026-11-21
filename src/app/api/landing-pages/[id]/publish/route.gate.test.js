// The landing-page publish route on withAuth: a signed-out
// call is withAuth's 401 'Unauthorized' (it said 'Unauthorised' before),
// and nothing is read or written. Everything after the sign-in is unchanged
// and covered by route.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn(async () => null) }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const publish = await import('./route.js')

const PAGE = '1a000000-0000-4000-8000-000000000001'

beforeEach(() => { vi.clearAllMocks() })

describe('landing-page writes signed out', () => {
  it('publish: 401, nothing read', async () => {
    const res = await publish.POST(new Request('http://localhost/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: PAGE }) })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
