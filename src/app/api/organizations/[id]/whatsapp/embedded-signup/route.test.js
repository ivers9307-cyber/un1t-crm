// WAORGNUMBER.1 (Task 5) — Embedded Signup at the organisation.
//
// The exchange route is org-admin gated. A phone number another ORGANISATION
// already holds is a 409 BEFORE any Meta-side mutation. A number this
// organisation already holds is reconnected in place (token refreshed, home
// studio kept). A NEW number needs a home studio of the organisation. The home
// studio's switch-on row is the database trigger's job, never the route's.
// Fictional values only (the repo is public).

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
vi.mock('@/lib/whatsapp-embedded-signup', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    exchangeCodeForBusinessToken: vi.fn(async () => 'SYNTH-BUSINESS-TOKEN-0000000000'),
    subscribeAppToWaba: vi.fn(async () => true),
    probeNumber: vi.fn(async () => ({ status: 'CONNECTED', platform_type: 'CLOUD_API', display_phone_number: '+353 1 000 0000', verified_name: 'Test Studio' })),
    registerNumber: vi.fn(async () => true),
    generatePin: vi.fn(() => '654321'),
    getWabaPhoneNumber: vi.fn(),
  }
})

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fakeOrgNumbersDb } from '@/lib/org-whatsapp-numbers-fake-db.test-helpers'
import * as es from '@/lib/whatsapp-embedded-signup'

const ORG = 'b0000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = 'b0000000-0000-4000-8000-0000000000a2'
const HOME = 'a0000000-0000-4000-8000-000000000001'
const FOREIGN = 'a0000000-0000-4000-8000-0000000000f1'
const NUM = 'c0000000-0000-4000-8000-00000000000a'

const DIALOG = { mode: 'cloud_api', code: 'SYNTH-CODE', waba_id: '555', phone_number_id: '100200300' }

function setup(extra = {}) {
  const state = {
    locations: [{ id: HOME, organization_id: ORG }, { id: FOREIGN, organization_id: OTHER_ORG }],
    numbers: [],
    ...extra,
  }
  createServerClient.mockReturnValue(fakeOrgNumbersDb(state))
  return state
}
const writes = (state) => state.ops.filter((o) => o.op !== 'select')

const post = (body, orgId = ORG) => POST(
  new Request(`http://x/api/organizations/${orgId}/whatsapp/embedded-signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: orgId }) },
)
const get = (orgId = ORG) => GET(new Request(`http://x/api/organizations/${orgId}/whatsapp/embedded-signup`), { params: Promise.resolve({ id: orgId }) })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_ID = '777'
  process.env.WHATSAPP_APP_SECRET = 'SYNTH-APP-SECRET'
  process.env.WHATSAPP_ES_CONFIG_ID = '888'
  getCurrentUser.mockResolvedValue({ id: 'u-admin', isMaster: false, orgAdminOrgIds: [ORG] })
})

describe('embedded-signup at the organisation', () => {
  it('GET: non-admin is 403; an admin gets the launch config', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: false, orgAdminOrgIds: [] })
    expect((await get()).status).toBe(403)
    getCurrentUser.mockResolvedValue({ id: 'u-admin', isMaster: false, orgAdminOrgIds: [ORG] })
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ configured: true, app_id: '777', config_id: '888' })
  })

  it('POST: non-admin is 403 before any Meta call', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: false, orgAdminOrgIds: [] })
    setup()
    expect((await post({ ...DIALOG, home_location_id: HOME })).status).toBe(403)
    expect(es.exchangeCodeForBusinessToken).not.toHaveBeenCalled()
  })

  it('a number another organisation holds is a 409 BEFORE any Meta-side mutation', async () => {
    const state = setup({ numbers: [{ id: NUM, organization_id: OTHER_ORG, location_id: FOREIGN, phone_number_id: '100200300', signup_meta: null }] })
    const res = await post({ ...DIALOG, home_location_id: HOME })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/different organi[sz]ation/)
    expect(es.subscribeAppToWaba).not.toHaveBeenCalled()
    expect(es.registerNumber).not.toHaveBeenCalled()
    expect(writes(state)).toEqual([])
  })

  it('a new number with no home studio is 400 before any Meta-side mutation', async () => {
    const state = setup()
    const res = await post(DIALOG)
    expect(res.status).toBe(400)
    expect(es.subscribeAppToWaba).not.toHaveBeenCalled()
    expect(writes(state)).toEqual([])
  })

  it('a home studio of another organisation is 400 before any Meta-side mutation', async () => {
    const state = setup()
    const res = await post({ ...DIALOG, home_location_id: FOREIGN })
    expect(res.status).toBe(400)
    expect(es.subscribeAppToWaba).not.toHaveBeenCalled()
    expect(writes(state)).toEqual([])
  })

  it('a new number is inserted for the organisation at its home studio; the ROUTE switches it on there (ORGCONTACTS.0)', async () => {
    const state = setup()
    const res = await post({ ...DIALOG, home_location_id: HOME })
    expect(res.status).toBe(200)
    const inserts = state.ops.filter((o) => o.op === 'insert')
    expect(inserts.map((o) => o.table)).toEqual(['whatsapp_numbers', 'location_whatsapp_numbers'])
    expect(inserts[0].payload).toMatchObject({
      organization_id: ORG, location_id: HOME, phone_number_id: '100200300', business_account_id: '555',
      connected_via: 'embedded_signup', token_type: 'business', is_active: true,
    })
    expect(inserts[0].payload).not.toHaveProperty('is_default')
    expect(inserts[1].payload).toEqual({ location_id: HOME, whatsapp_number_id: state.numbers[0].id, is_default: true, created_by: 'u-admin' })
    expect(state.links).toHaveLength(1)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('SYNTH-BUSINESS')
  })

  it('a number this organisation already holds is reconnected in place and keeps its home studio', async () => {
    const state = setup({
      numbers: [{ id: NUM, organization_id: ORG, location_id: HOME, phone_number_id: '100200300', signup_meta: { pin: '111111' }, access_token: 'old' }],
    })
    const res = await post(DIALOG)
    expect(res.status).toBe(200)
    expect(state.ops.filter((o) => o.op === 'insert')).toEqual([])
    const row = state.numbers[0]
    expect(row.location_id).toBe(HOME)
    expect(row.access_token).toBe('SYNTH-BUSINESS-TOKEN-0000000000')
    expect(row.is_active).toBe(true)
    expect(row.signup_meta.pin).toBe('111111')
  })
})
