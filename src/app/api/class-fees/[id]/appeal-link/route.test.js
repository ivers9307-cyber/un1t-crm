// FEES.3 — POST /api/class-fees/[id]/appeal-link through the real withAuth
// wrapper. The hand-written checks run in their old order: id 404, body 400,
// studio membership 403, class_fees at the body's studio 403.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-fees-member', () => ({ issueAppealLink: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { issueAppealLink } = await import('@/lib/class-fees-member')
const { POST } = await import('./route.js')

const FEE = 'e0000000-0000-4000-8000-0000000000f1'
const post = (body, id = FEE) => POST(
  new Request(`http://localhost/api/class-fees/${id}/appeal-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
)
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { class_fees: a } }, [LOC_B]: { role: 'owner', permissions: { class_fees: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  issueAppealLink.mockResolvedValue({ ok: true, url: 'https://example.com/appeal/t' })
})

describe('POST /api/class-fees/[id]/appeal-link', () => {
  it('401 signed out, no link made', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ location_id: LOC_B })).status).toBe(401)
    expect(issueAppealLink).not.toHaveBeenCalled()
  })

  it('404 for a malformed id; 400 without a location_id', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({}, 'nope')).status).toBe(404)
    expect((await post({})).status).toBe(400)
  })

  it('403 for a studio the caller is not in; 403 "Forbidden" without class_fees there', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({ location_id: LOC_OTHER })).status).toBe(403)
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await post({ location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(issueAppealLink).not.toHaveBeenCalled()
  })

  it('an allowed caller gets a fresh link for the body\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    const res = await post({ location_id: LOC_B })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://example.com/appeal/t' } })
    expect(issueAppealLink).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_B, feeId: FEE })
  })
})
