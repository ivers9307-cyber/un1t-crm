// EMAIL-CONV-STOP.1 — GET/PATCH /api/email/conversations/[id] are RETIRED.
//
// Both used to touch the mig 394 tables — GET read the thread AND zeroed
// unread_count, PATCH stamped resolved_at. Both now answer 410 Gone with no
// database work at all, which `createServerClient` never being called is what
// proves.
//
// The 401/403 tests stay: the guard is deliberately in FRONT of the 410 so the
// retirement cannot be used to enumerate routes, and `check:route-guards`
// requires the channel-permission check on everything under this directory.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, PATCH } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { WA_ONLY, EMAIL_ONLY, CONV_ID } from '../_test-fixtures'

function get(id = CONV_ID) {
  return GET(new Request(`http://x/api/email/conversations/${id}`), { params: Promise.resolve({ id }) })
}
function patch(id = CONV_ID, body = { resolved: true }) {
  return PATCH(
    new Request(`http://x/api/email/conversations/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(EMAIL_ONLY)
})

describe('GET /api/email/conversations/[id] — retired', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403s a user holding `whatsapp` but NOT `email_inbox`', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    expect((await get()).status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('410s with an actionable message and reads NOTHING', async () => {
    const res = await get()
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/retired/i)
    expect(body.error).toMatch(/ticket/i)
    // The old handler zeroed unread_count as a side effect of a GET.
    expect(createServerClient).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/email/conversations/[id] — retired', () => {
  it('403s a user holding `whatsapp` but NOT `email_inbox`', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    expect((await patch()).status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('410s and resolves nothing', async () => {
    const res = await patch()
    expect(res.status).toBe(410)
    expect((await res.json()).success).toBe(false)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('410s even on a well-formed body — the schema is gone too', async () => {
    expect((await patch(CONV_ID, { resolved: false })).status).toBe(410)
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
