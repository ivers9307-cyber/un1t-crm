// INBOX-PERM.2 — GET /api/email/conversations (the legacy list route).
//
// THE LOAD-BEARING ASSERTION is the second test: a user with the WhatsApp
// inbox switched ON and the email inbox switched OFF gets 403. This route runs
// on the service-role client, so RLS does nothing and requireInboxPermission
// IS the gate — and until INBOX-PERM.2 it resolved the `em` channel against
// the `whatsapp` key, so exactly that user could read the studio's email.

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
import { makeDb } from '../tickets/_test-db'
import { LOC_A, LOC_B, WA_ONLY, EMAIL_ONLY, CONV, baseState } from './_test-fixtures'

function get(query = '') {
  return GET(new Request(`http://x/api/email/conversations${query}`))
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb(baseState())
  createServerClient.mockImplementation(() => db)
  getCurrentUser.mockResolvedValue(EMAIL_ONLY)
})

describe('GET /api/email/conversations', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403s a user holding `whatsapp` but NOT `email_inbox`', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    const res = await get()
    expect(res.status).toBe(403)
    // Nothing was read: the gate runs before any DB work.
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('allows a user holding `email_inbox` (and no whatsapp at all)', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).conversations.map(c => c.id)).toEqual([CONV.id])
  })

  it('scopes to the caller’s locations', async () => {
    getCurrentUser.mockResolvedValue({ ...EMAIL_ONLY, locations: [{ id: LOC_B }] })
    const res = await get()
    expect((await res.json()).conversations).toEqual([])
  })

  it('403s an explicit ?location_id the caller has no access to', async () => {
    expect((await get(`?location_id=${LOC_B}`)).status).toBe(403)
    expect((await get(`?location_id=${LOC_A}`)).status).toBe(200)
  })
})
