// EMAIL-CONV-STOP.1 — GET /api/email/conversations is RETIRED.
//
// It used to list the mig 394 email conversations. It now answers 410 Gone and
// performs NO database work at all: createServerClient is never called, which
// is the assertion that actually proves the table is untouched (a status-code
// check alone would still pass if the handler queried and then discarded).
//
// The 401/403 tests are not leftovers. The guard stays in front of the 410 on
// purpose — so an unauthenticated caller cannot use the retirement to
// enumerate which routes exist — and `check:route-guards` requires every route
// under src/app/api/email/conversations to carry the channel-permission check.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  // requireInboxPermission is deliberately NOT mocked — it is what is on trial.
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { WA_ONLY, EMAIL_ONLY, LOC_A } from './_test-fixtures'

function get(query = '') {
  return GET(new Request(`http://x/api/email/conversations${query}`))
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(EMAIL_ONLY)
})

describe('GET /api/email/conversations — retired', () => {
  it('401s when unauthenticated, before saying anything about the route', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('403s a user holding `whatsapp` but NOT `email_inbox`', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    expect((await get()).status).toBe(403)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('410s the caller who DOES hold `email_inbox`', async () => {
    const res = await get()
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body.success).toBe(false)
    // A sentence a human can act on — the app cannot distinguish a 404 from a
    // network error, which is why the route was stubbed rather than deleted.
    expect(body.error).toMatch(/retired/i)
    expect(body.error).toMatch(/ticket/i)
  })

  it('never touches the database — not even with a location filter', async () => {
    await get()
    await get(`?location_id=${LOC_A}`)
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
