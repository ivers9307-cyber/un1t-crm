// WAORGNUMBER.1 (Task 5) — numbers are added at the organisation now, so the
// studio-level POST answers 410 and points at the organisation page (it still
// refuses a signed-out caller first). The GET stays: it lists the numbers the
// studio can use.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => { throw new Error('a retired route must not touch the database') }) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const post = () => POST(
  new Request(`http://x/api/locations/${LOC}/whatsapp/numbers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  { params: Promise.resolve({ id: LOC }) },
)

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner' }) })

describe('POST /api/locations/[id]/whatsapp/numbers (retired)', () => {
  it('old location POST answers 410 with moved_to', async () => {
    const res = await post()
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      success: false,
      error: 'WhatsApp numbers are managed at the organisation now.',
      moved_to: '/settings/whatsapp-numbers',
    })
  })

  it('a signed-out caller still gets 401, not the pointer', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })
})
