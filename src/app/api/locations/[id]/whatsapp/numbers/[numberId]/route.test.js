// N8NECHO.1 — the WhatsApp number PATCH and the masked token round-trip.
//
// The numbers screens show a stored Meta token as the shared mask
// (publicShape().access_token_redacted === SECRET_MASK, presence only). If a
// client ever sends that mask back as access_token, the stored token must
// stay exactly as it is: the PATCH refuses the body (the token must be at
// least 20 characters, and no mask shape is) and writes nothing. The old
// 4-bullet-plus-last-6 shape is pinned too. Fictional values only (public
// repo): every secret starts SYNTH-.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  guardMasterOrOwner: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PATCH } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import { SECRET_MASK } from '@/lib/secret-keys'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const NUM = 'c0000000-0000-4000-8000-00000000000a'
const STORED_TOKEN = 'SYNTH-WA-SYSTEM-USER-TOKEN-0000'

const STORED = {
  id: NUM, location_id: LOC, label: 'Front desk', phone_number_id: '100',
  business_account_id: '200', app_id: '300', display_phone: '+353 00 000 0000',
  source: 'cloud_api', token_type: 'system_user', connected_via: 'manual',
  is_default: true, is_active: true, access_token: STORED_TOKEN, signup_meta: null,
  created_at: null, updated_at: null,
}

// The row lives in `stored`; an update merges its argument into it, the way
// the database would, so "the stored value is unchanged" is read off the row.
function mockDb() {
  const state = { stored: { ...STORED }, updates: [] }
  const db = {
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: state.stored.id, location_id: state.stored.location_id }, error: null }) }) }),
      update: (arg) => {
        state.updates.push(arg)
        state.stored = { ...state.stored, ...arg }
        const chain = {
          eq: () => chain,
          neq: () => chain,
          select: () => ({ single: async () => ({ data: state.stored, error: null }) }),
          then: (resolve) => resolve({ data: null, error: null }),
        }
        return chain
      },
    })),
  }
  createServerClient.mockReturnValue(db)
  return state
}

const patch = (body) => PATCH(
  new Request(`http://x/api/locations/${LOC}/whatsapp/numbers/${NUM}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: LOC, numberId: NUM }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner' })
})

describe('PATCH whatsapp number: a masked token echo never overwrites the stored token (N8NECHO.1)', () => {
  it('round-trip: the mask the screen is given, sent back, leaves the stored token unchanged', async () => {
    const state = mockDb()
    const echoed = publicShape(state.stored).access_token_redacted
    expect(echoed).toBe(SECRET_MASK)

    const res = await patch({ label: 'Front desk', access_token: echoed })
    expect(res.status).toBe(400)
    expect(state.updates.some((u) => 'access_token' in u)).toBe(false)
    expect(state.stored.access_token).toBe(STORED_TOKEN)
  })

  it('the old tail-keeping mask shape is refused the same way', async () => {
    const state = mockDb()
    const res = await patch({ access_token: '••••' + STORED_TOKEN.slice(-6) })
    expect(res.status).toBe(400)
    expect(state.updates).toEqual([])
    expect(state.stored.access_token).toBe(STORED_TOKEN)
  })

  it('a save without a token keeps the stored token and answers with the mask, not a tail', async () => {
    const state = mockDb()
    const res = await patch({ label: 'Front desk 2' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(state.stored.access_token).toBe(STORED_TOKEN)
    expect(state.updates.some((u) => 'access_token' in u)).toBe(false)
    expect(body.number.access_token_redacted).toBe(SECRET_MASK)
    expect(JSON.stringify(body)).not.toMatch(/SYNTH-|N-0000/)
  })

  it('a real new token is written (the refusal is for masks, not for tokens)', async () => {
    const state = mockDb()
    const res = await patch({ access_token: 'SYNTH-WA-NEW-SYSTEM-USER-TOKEN-1111' })
    expect(res.status).toBe(200)
    expect(state.stored.access_token).toBe('SYNTH-WA-NEW-SYSTEM-USER-TOKEN-1111')
  })
})
