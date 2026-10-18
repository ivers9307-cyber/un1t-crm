// WAORGNUMBER.1 (Task 5) — Embedded Signup runs at the organisation now: the
// studio-level POST answers 410 with a pointer, before any Meta call. The GET
// launch config stays.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => { throw new Error('a retired route must not touch the database') }) }))
vi.mock('@/lib/whatsapp-embedded-signup', async (importOriginal) => ({
  ...(await importOriginal()),
  exchangeCodeForBusinessToken: vi.fn(),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { exchangeCodeForBusinessToken } from '@/lib/whatsapp-embedded-signup'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const post = () => POST(
  new Request(`http://x/api/locations/${LOC}/whatsapp/embedded-signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'c', waba_id: '1' }),
  }),
  { params: Promise.resolve({ id: LOC }) },
)

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner' }) })

describe('POST /api/locations/[id]/whatsapp/embedded-signup (retired)', () => {
  it('answers 410 with moved_to and never calls Meta', async () => {
    const res = await post()
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      success: false,
      error: 'WhatsApp numbers are managed at the organisation now.',
      moved_to: '/settings/whatsapp-numbers',
    })
    expect(exchangeCodeForBusinessToken).not.toHaveBeenCalled()
  })

  it('a signed-out caller still gets 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
  })
})
