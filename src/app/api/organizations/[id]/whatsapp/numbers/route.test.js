// WAORGNUMBER.1 (Task 5) — the organisation's WhatsApp numbers: list and add.
//
// An organisation admin (or a master) manages the organisation's numbers;
// anyone else is refused. Adding a number files it at a HOME studio of the
// organisation (a studio of another organisation is a 400: the database does
// not refuse it). The route does NOT write the home studio's switch-on row: mig
// 736's AFTER INSERT trigger does (default only when that studio has none yet),
// so the route test pins that it never inserts one. Fictional values only (the
// repo is public): every secret starts SYNTH-.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // The real rule (src/lib/auth.js): master passes, an org_admin grant on that org passes.
  assertOrganizationAdmin: vi.fn((user, orgId) => {
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    if (user.isMaster) return null
    if (orgId && (user.orgAdminOrgIds || []).includes(orgId)) return null
    return NextResponse.json({ success: false, error: 'Master or organization admin role required.' }, { status: 403 })
  }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeOrgNumbersDb } from '@/lib/org-whatsapp-numbers-fake-db.test-helpers'
import { SECRET_MASK } from '@/lib/secret-keys'

const ORG = 'b0000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = 'b0000000-0000-4000-8000-0000000000a2'
const HOME = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const FOREIGN = 'a0000000-0000-4000-8000-0000000000f1'
const TOKEN = 'SYNTH-WA-SYSTEM-USER-TOKEN-0000'

const BODY = {
  label: 'Front desk', phone_number_id: '100200300', access_token: TOKEN,
  business_account_id: '555', app_id: '777', display_phone: '+353 1 000 0000',
  source: 'cloud_api', home_location_id: HOME,
}

function setup(extra = {}) {
  const state = {
    locations: [
      { id: HOME, organization_id: ORG },
      { id: HATCH, organization_id: ORG },
      { id: FOREIGN, organization_id: OTHER_ORG },
    ],
    numbers: [],
    ...extra,
  }
  createServerClient.mockReturnValue(fakeOrgNumbersDb(state))
  return state
}

const call = (handler, body, orgId = ORG) => handler(
  new Request(`http://x/api/organizations/${orgId}/whatsapp/numbers`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: orgId }) },
)

const ADMIN = { id: 'u-admin', isMaster: false, orgAdminOrgIds: [ORG] }
const writes = (state) => state.ops.filter((o) => o.op !== 'select')

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(ADMIN)
})

describe('POST /api/organizations/[id]/whatsapp/numbers', () => {
  it('signed out gets 401 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const state = setup()
    const res = await call(POST, BODY)
    expect(res.status).toBe(401)
    expect(writes(state)).toEqual([])
  })

  it('non-admin gets 403 (an owner at a studio is not an organisation admin) and nothing is written', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-owner', isMaster: false, role: 'owner', orgAdminOrgIds: [] })
    const state = setup()
    const res = await call(POST, BODY)
    expect(res.status).toBe(403)
    expect(writes(state)).toEqual([])
  })

  it('an admin of ANOTHER organisation gets 403', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-x', isMaster: false, orgAdminOrgIds: [OTHER_ORG] })
    const state = setup()
    const res = await call(POST, BODY)
    expect(res.status).toBe(403)
    expect(writes(state)).toEqual([])
  })

  it('org admin adds a number with its home studio switched on as default (the trigger writes the link; the route never does)', async () => {
    const state = setup()
    const res = await call(POST, BODY)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // One insert, into whatsapp_numbers, carrying the organisation and the home studio.
    const inserts = state.ops.filter((o) => o.op === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('whatsapp_numbers')
    expect(inserts[0].payload).toMatchObject({
      organization_id: ORG, location_id: HOME, label: 'Front desk', phone_number_id: '100200300', source: 'cloud_api',
    })
    // The deprecated per-number default is not driven from here.
    expect(inserts[0].payload.is_default).not.toBe(true)

    // The home studio is switched on, as default, by the (simulated) trigger.
    expect(state.links).toHaveLength(1)
    expect(state.links[0]).toMatchObject({ location_id: HOME, whatsapp_number_id: body.number.id, is_default: true })
    // …and the route only stamped who did it, never inserted a link itself.
    expect(state.ops.some((o) => o.table === 'location_whatsapp_numbers' && o.op === 'insert')).toBe(false)
    expect(state.links[0].created_by).toBe('u-admin')

    // The token reaches the browser as the mask only.
    expect(body.number.access_token_redacted).toBe(SECRET_MASK)
    expect(JSON.stringify(body)).not.toContain('SYNTH-')
  })

  it('a second number at a studio that already has a default link is switched on but not default', async () => {
    const state = setup()
    await call(POST, BODY)
    const res = await call(POST, { ...BODY, label: 'Back office', phone_number_id: '100200301' })
    expect(res.status).toBe(200)
    expect(state.links.map((l) => l.is_default)).toEqual([true, false])
  })

  it('a home studio of another organisation is 400 and nothing is written', async () => {
    const state = setup()
    const res = await call(POST, { ...BODY, home_location_id: FOREIGN })
    expect(res.status).toBe(400)
    expect(writes(state)).toEqual([])
  })

  it('a home studio that does not exist is 400', async () => {
    const state = setup()
    const res = await call(POST, { ...BODY, home_location_id: 'a0000000-0000-4000-8000-0000000000ff' })
    expect(res.status).toBe(400)
    expect(writes(state)).toEqual([])
  })

  it('a missing home studio is 400 (validation)', async () => {
    const state = setup()
    const { home_location_id: _omit, ...rest } = BODY
    const res = await call(POST, rest)
    expect(res.status).toBe(400)
    expect(writes(state)).toEqual([])
  })

  it('a phone_number_id already registered is a 409', async () => {
    const state = setup({ faults: { 'whatsapp_numbers:insert': { message: 'duplicate key value violates unique constraint "whatsapp_numbers_phone_number_id_key"' } } })
    const res = await call(POST, BODY)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already registered/)
    expect(state.links).toEqual([])
  })

  it('a master adds a number to any organisation', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u-master', isMaster: true, orgAdminOrgIds: [] })
    const state = setup()
    const res = await call(POST, { ...BODY, home_location_id: FOREIGN }, OTHER_ORG)
    expect(res.status).toBe(200)
    expect(state.numbers[0]).toMatchObject({ organization_id: OTHER_ORG, location_id: FOREIGN })
  })

  it('a failure stamping created_by does not fail the add', async () => {
    const state = setup({ faults: { 'location_whatsapp_numbers:update': { message: 'boom' } } })
    const res = await call(POST, BODY)
    expect(res.status).toBe(200)
    expect(state.numbers).toHaveLength(1)
  })
})

describe('GET /api/organizations/[id]/whatsapp/numbers', () => {
  const NUM = (over) => ({
    id: 'n1', organization_id: ORG, location_id: HOME, label: 'Front desk', phone_number_id: '100',
    business_account_id: '200', app_id: '300', display_phone: null, source: 'cloud_api', token_type: 'system_user',
    connected_via: 'manual', is_default: false, is_active: true, access_token: TOKEN, signup_meta: { pin: '123456' },
    created_at: null, updated_at: null, ...over,
  })

  it('non-admin gets 403', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: false, orgAdminOrgIds: [] })
    setup({ numbers: [NUM()] })
    expect((await call(GET)).status).toBe(403)
  })

  it('lists only this organisation\'s numbers, masked, with no token or PIN anywhere', async () => {
    setup({ numbers: [NUM(), NUM({ id: 'n2', organization_id: OTHER_ORG, location_id: FOREIGN, label: 'Elsewhere', phone_number_id: '999' })] })
    const res = await call(GET)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.numbers.map((n) => n.id)).toEqual(['n1'])
    expect(body.numbers[0].access_token_redacted).toBe(SECRET_MASK)
    expect(body.numbers[0].location_id).toBe(HOME)
    const text = JSON.stringify(body)
    expect(text).not.toContain('SYNTH-')
    expect(text).not.toContain('123456')
  })

  it('a database error is a 500, not an empty list', async () => {
    setup({ faults: { 'whatsapp_numbers:select': { message: 'boom' } } })
    expect((await call(GET)).status).toBe(500)
  })
})
