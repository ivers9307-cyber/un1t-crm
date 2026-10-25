// WAORGNUMBER.1 (Task 5) — editing and removing a number happen at the
// organisation now, so the studio-level PATCH and DELETE answer 410 with a
// pointer. The masked-token round trip this file used to pin (N8NECHO.1) is
// pinned on the organisation route:
// src/app/api/organizations/[id]/whatsapp/numbers/[numberId]/route.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => { throw new Error('a retired route must not touch the database') }) }))

import { PATCH, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const NUM = 'c0000000-0000-4000-8000-00000000000a'
const ctx = { params: Promise.resolve({ id: LOC, numberId: NUM }) }
const url = `http://x/api/locations/${LOC}/whatsapp/numbers/${NUM}`
const MOVED = {
  success: false,
  error: 'WhatsApp numbers are managed at the organisation now.',
  moved_to: '/settings/integrations-hub?manage=whatsapp-numbers',
}

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner' }) })

describe('PATCH and DELETE /api/locations/[id]/whatsapp/numbers/[numberId] (retired)', () => {
  it('PATCH answers 410 with moved_to', async () => {
    const res = await PATCH(new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"label":"x"}' }), ctx)
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual(MOVED)
  })

  it('DELETE answers 410 with moved_to', async () => {
    const res = await DELETE(new Request(url, { method: 'DELETE' }), ctx)
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual(MOVED)
  })

  it('a signed-out caller still gets 401 on both', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(new Request(url, { method: 'PATCH', body: '{}' }), ctx)).status).toBe(401)
    expect((await DELETE(new Request(url, { method: 'DELETE' }), ctx)).status).toBe(401)
  })
})
