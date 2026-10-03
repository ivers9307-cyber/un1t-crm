// C123 GATES-4 (b) — the Clone button on the /automations flow list showed to
// every flow builder (email OR whatsapp), but POST /api/sequences/[id]/clone
// needs `email` (at some studio, membership of the source's studio, then
// `email` there), so a WhatsApp-only builder saw a button that always 403'd.
// canCloneSequenceAt is the route's rule for the button; this pins it to the
// REAL route: for every caller, the helper says yes exactly when the route
// gets past its gates. Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  person, LOC_A, LOC_B, permissionCases, OUTSIDER,
} from './helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { POST } from '@/app/api/sequences/[id]/clone/route.js'
import { canCloneSequenceAt } from '@/lib/sequence-access'

const SEQ_ID = '5e000000-0000-4000-8000-000000000001'

// The source row at `loc`; anything after the gates (the insert) fails, so a
// caller who gets past them sees a 500, never a 403/404.
function dbWithSequenceAt(loc) {
  const chain = {
    select: () => chain, eq: () => chain, insert: () => chain, order: () => chain,
    single: async () => ({ data: { id: SEQ_ID, name: 'Welcome', location_id: loc, trigger_type: 'manual', sequence_steps: [] }, error: null }),
    then: (r) => r({ data: null, error: { message: 'stop after the gates' } }),
  }
  let reads = 0
  return {
    from: () => {
      reads += 1
      if (reads === 1) return chain
      const fail = {
        select: () => fail, eq: () => fail, insert: () => fail, order: () => fail,
        single: async () => ({ data: null, error: { message: 'stop after the gates' } }),
        then: (r) => r({ data: null, error: { message: 'stop after the gates' } }),
      }
      return fail
    },
  }
}

async function routePasses(user, loc) {
  getCurrentUser.mockResolvedValue(user)
  createServerClient.mockReturnValue(dbWithSequenceAt(loc))
  const res = await POST(new Request('http://localhost/api/x', { method: 'POST' }), { params: Promise.resolve({ id: SEQ_ID }) })
  return res.status !== 401 && res.status !== 403 && res.status !== 404
}

// A WhatsApp-only builder (the row's case): whatsapp on, email off, at B.
const WHATSAPP_ONLY = person({ [LOC_B]: { role: 'staff', permissions: { email: false, whatsapp: true } } }, LOC_B)
const EMAIL_FEATURE_OFF = person({ [LOC_B]: { role: 'owner', features: { email: false } } }, LOC_B)

const cases = [
  ...permissionCases('email').map(([label, user, loc, want]) => [label, user, loc, want === 'pass']),
  ['a WhatsApp-only builder', WHATSAPP_ONLY, LOC_B, false],
  ['an owner at a studio with the email feature off', EMAIL_FEATURE_OFF, LOC_B, false],
  ['an owner outside the studio', OUTSIDER, LOC_B, false],
  ['an owner at A only, the sequence at A', person({ [LOC_A]: { role: 'owner' } }, LOC_A), LOC_A, true],
]

beforeEach(() => vi.clearAllMocks())

describe('canCloneSequenceAt matches POST /api/sequences/[id]/clone', () => {
  it.each(cases)('%s', async (_label, user, loc, want) => {
    expect(canCloneSequenceAt(user, loc)).toBe(want)
    expect(await routePasses(user, loc)).toBe(want)
  })

  it('no user or no studio: no button', () => {
    expect(canCloneSequenceAt(null, LOC_B)).toBe(false)
    expect(canCloneSequenceAt(WHATSAPP_ONLY, null)).toBe(false)
  })
})
