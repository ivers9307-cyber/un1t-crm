// WAORGNUMBER.1 (Task 5) — edit and delete one of the organisation's WhatsApp
// numbers.
//
// The N8NECHO.1 rule moved here with the route: a masked (or blank) token echoed
// back never overwrites the stored token. New: a number of ANOTHER organisation
// is a 404 (never a 403, so ids cannot be enumerated); the home studio may move,
// but only to a studio of the same organisation (the database refuses moving the
// number across organisations only when a link would cross, not the home column
// itself); PATCH never touches switch-on rows, and DELETE leaves the links to
// the database's cascade. Fictional values only (the repo is public).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertOrganizationAdmin: vi.fn((user, orgId) => {
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    if (user.isMaster) return null
    if (orgId && (user.orgAdminOrgIds || []).includes(orgId)) return null
    return NextResponse.json({ success: false, error: 'Master or organization admin role required.' }, { status: 403 })
  }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PATCH, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeOrgNumbersDb } from '@/lib/org-whatsapp-numbers-fake-db.test-helpers'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import { SECRET_MASK } from '@/lib/secret-keys'

const ORG = 'b0000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = 'b0000000-0000-4000-8000-0000000000a2'
const HOME = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const FOREIGN = 'a0000000-0000-4000-8000-0000000000f1'
const NUM = 'c0000000-0000-4000-8000-00000000000a'
const THEIRS = 'c0000000-0000-4000-8000-00000000000b'
const STORED_TOKEN = 'SYNTH-WA-SYSTEM-USER-TOKEN-0000'

const STORED = () => ({
  id: NUM, organization_id: ORG, location_id: HOME, label: 'Front desk', phone_number_id: '100',
  business_account_id: '200', app_id: '300', display_phone: '+353 00 000 0000',
  source: 'cloud_api', token_type: 'system_user', connected_via: 'manual',
  is_default: false, is_active: true, access_token: STORED_TOKEN, signup_meta: null,
  created_at: null, updated_at: null,
})
const THEIR_ROW = () => ({ ...STORED(), id: THEIRS, organization_id: OTHER_ORG, location_id: FOREIGN, label: 'Elsewhere', phone_number_id: '999' })

function setup(extra = {}) {
  const state = {
    locations: [
      { id: HOME, organization_id: ORG },
      { id: HATCH, organization_id: ORG },
      { id: FOREIGN, organization_id: OTHER_ORG },
    ],
    numbers: [STORED(), THEIR_ROW()],
    links: [{ location_id: HOME, whatsapp_number_id: NUM, is_default: true }],
    ...extra,
  }
  createServerClient.mockReturnValue(fakeOrgNumbersDb(state))
  return state
}
const stored = (state, id = NUM) => state.numbers.find((n) => n.id === id)
const writes = (state) => state.ops.filter((o) => o.op !== 'select')

const patch = (body, { orgId = ORG, numberId = NUM } = {}) => PATCH(
  new Request(`http://x/api/organizations/${orgId}/whatsapp/numbers/${numberId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: orgId, numberId }) },
)
const del = ({ orgId = ORG, numberId = NUM } = {}) => DELETE(
  new Request(`http://x/api/organizations/${orgId}/whatsapp/numbers/${numberId}`, { method: 'DELETE' }),
  { params: Promise.resolve({ id: orgId, numberId }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u-admin', isMaster: false, orgAdminOrgIds: [ORG] })
})

describe('who may edit or delete', () => {
  it('non-admin gets 403 on PATCH and DELETE and nothing is written', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-owner', isMaster: false, role: 'owner', orgAdminOrgIds: [] })
    const state = setup()
    expect((await patch({ label: 'x' })).status).toBe(403)
    expect((await del()).status).toBe(403)
    expect(writes(state)).toEqual([])
  })

  it('PATCH another organisation\'s number is 404, and so is DELETE (never 403, never a write)', async () => {
    const state = setup()
    // The caller administers ORG; THEIRS belongs to OTHER_ORG, addressed through ORG's route.
    const p = await patch({ label: 'hijack' }, { numberId: THEIRS })
    expect(p.status).toBe(404)
    const d = await del({ numberId: THEIRS })
    expect(d.status).toBe(404)
    expect(writes(state)).toEqual([])
    expect(stored(state, THEIRS).label).toBe('Elsewhere')
  })

  it('a number that does not exist is 404', async () => {
    const state = setup()
    expect((await patch({ label: 'x' }, { numberId: 'c0000000-0000-4000-8000-0000000000ff' })).status).toBe(404)
    expect(writes(state)).toEqual([])
  })

  it('a master edits a number of any organisation', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-master', isMaster: true, orgAdminOrgIds: [] })
    const state = setup()
    const res = await patch({ label: 'renamed' }, { orgId: OTHER_ORG, numberId: THEIRS })
    expect(res.status).toBe(200)
    expect(stored(state, THEIRS).label).toBe('renamed')
  })
})

describe('PATCH: a masked token echo never overwrites the stored token (N8NECHO.1)', () => {
  it('round-trip: the mask the screen is given, sent back with a label change, saves the label and leaves the stored token unchanged', async () => {
    const state = setup()
    const echoed = publicShape(stored(state)).access_token_redacted
    expect(echoed).toBe(SECRET_MASK)

    const res = await patch({ label: 'Front desk renamed', access_token: echoed })
    expect(res.status).toBe(200)
    expect(state.ops.some((u) => u.op === 'update' && 'access_token' in u.payload)).toBe(false)
    expect(stored(state).access_token).toBe(STORED_TOKEN)
    expect(stored(state).label).toBe('Front desk renamed')
  })

  it('the old tail-keeping mask shape is dropped the same way', async () => {
    const state = setup()
    const res = await patch({ access_token: '••••' + STORED_TOKEN.slice(-6) })
    expect(res.status).toBe(200)
    expect(stored(state).access_token).toBe(STORED_TOKEN)
  })

  it('a blank token is dropped too, not refused', async () => {
    const state = setup()
    const res = await patch({ label: 'Front desk 3', access_token: '' })
    expect(res.status).toBe(200)
    expect(stored(state).access_token).toBe(STORED_TOKEN)
    expect(stored(state).label).toBe('Front desk 3')
  })

  it('a save without a token keeps the stored token and answers with the mask, not a tail', async () => {
    const state = setup()
    const res = await patch({ label: 'Front desk 2' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(stored(state).access_token).toBe(STORED_TOKEN)
    expect(body.number.access_token_redacted).toBe(SECRET_MASK)
    expect(JSON.stringify(body)).not.toMatch(/SYNTH-|N-0000/)
  })

  it('a real new token is written (the refusal is for masks, not for tokens)', async () => {
    const state = setup()
    const res = await patch({ access_token: 'SYNTH-WA-NEW-SYSTEM-USER-TOKEN-1111' })
    expect(res.status).toBe(200)
    expect(stored(state).access_token).toBe('SYNTH-WA-NEW-SYSTEM-USER-TOKEN-1111')
  })
})

describe('PATCH: the home studio', () => {
  it('moves to another studio of the same organisation, and touches no switch-on row', async () => {
    const state = setup()
    const res = await patch({ home_location_id: HATCH })
    expect(res.status).toBe(200)
    expect(stored(state).location_id).toBe(HATCH)
    expect(state.ops.some((o) => o.table === 'location_whatsapp_numbers')).toBe(false)
    expect(state.links).toEqual([{ location_id: HOME, whatsapp_number_id: NUM, is_default: true }])
    // home_location_id is a request name; the column is location_id.
    expect(state.ops.find((o) => o.op === 'update').payload).not.toHaveProperty('home_location_id')
  })

  it('a studio of another organisation is 400 and nothing is written', async () => {
    const state = setup()
    const res = await patch({ home_location_id: FOREIGN })
    expect(res.status).toBe(400)
    expect(writes(state)).toEqual([])
    expect(stored(state).location_id).toBe(HOME)
  })

  it('a studio that does not exist is 400', async () => {
    const state = setup()
    const res = await patch({ home_location_id: 'a0000000-0000-4000-8000-0000000000ff' })
    expect(res.status).toBe(400)
    expect(writes(state)).toEqual([])
  })

  it('is_default is not an organisation-level setting: it is ignored, not written', async () => {
    const state = setup()
    const res = await patch({ label: 'x', is_default: true })
    expect(res.status).toBe(200)
    expect(state.ops.find((o) => o.op === 'update').payload).not.toHaveProperty('is_default')
  })

  it('deactivating saves is_active and nothing else is touched', async () => {
    const state = setup()
    const res = await patch({ is_active: false })
    expect(res.status).toBe(200)
    expect(stored(state).is_active).toBe(false)
  })

  it('a phone_number_id or label already in use is a 409', async () => {
    setup({ faults: { 'whatsapp_numbers:update': { message: 'duplicate key value violates unique constraint' } } })
    expect((await patch({ label: 'x' })).status).toBe(409)
  })
})

describe('DELETE', () => {
  it('deletes the number and leaves its switch-on rows to the database cascade', async () => {
    const state = setup()
    const res = await del()
    expect(res.status).toBe(200)
    expect(state.numbers.map((n) => n.id)).toEqual([THEIRS])
    expect(writes(state).map((o) => `${o.table}:${o.op}`)).toEqual(['whatsapp_numbers:delete'])
    // The fake applies the cascade the database performs.
    expect(state.links).toEqual([])
  })

  it('a database error is a 500', async () => {
    setup({ faults: { 'whatsapp_numbers:delete': { message: 'boom' } } })
    expect((await del()).status).toBe(500)
  })
})
