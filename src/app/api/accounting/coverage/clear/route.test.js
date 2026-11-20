// RCOV — POST /api/accounting/coverage/clear through the real withAuth wrapper:
// accounting_hub at the active studio; clears only that studio's open lines.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/recon/clear-board', () => ({ clearOpenLines: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { clearOpenLines } = await import('@/lib/recon/clear-board')
const { POST } = await import('./route.js')

const post = () => POST(new Request('http://localhost/api/accounting/coverage/clear', { method: 'POST' }))

beforeEach(() => {
  vi.clearAllMocks()
  clearOpenLines.mockResolvedValue({ cleared: 3 })
})

describe('POST /api/accounting/coverage/clear', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })

  it('403 for a manager at the active studio, even one who owns another studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'owner' } }, LOC_A))
    expect((await post()).status).toBe(403)
    expect(clearOpenLines).not.toHaveBeenCalled()
  })

  it('400 with no active studio, and nothing is cleared', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'owner' } }, LOC_A), activeLocation: null })
    const res = await post()
    expect(res.status).toBe(400)
    expect(clearOpenLines).not.toHaveBeenCalled()
  })

  it('an owner clears the active studio only', async () => {
    const owner = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_B)
    getCurrentUser.mockResolvedValue(owner)
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { cleared: 3 } })
    expect(clearOpenLines).toHaveBeenCalledWith({ tag: 'db' }, LOC_B, owner.id)
  })
})
