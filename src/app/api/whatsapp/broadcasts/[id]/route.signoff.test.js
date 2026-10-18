// WAORGNUMBER.4 (spec R7) — blast sign-off on the routes that schedule or
// restart a broadcast: PUT …/[id] (schedule; a content change clears the
// sign-off), POST /api/whatsapp/broadcasts (create as scheduled) and
// POST …/[id]/pause { paused: false } (a drip's resume).
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { PUT } from './route.js'
import { POST as CREATE } from '../route.js'
import { POST as PAUSE } from './pause/route.js'
import { getCurrentUser } from '@/lib/auth'

const BC = '11111111-1111-4111-8111-111111111111'
const TPL = '22222222-2222-4222-8222-222222222222'
const ADMIN_ID = '33333333-3333-4333-8333-333333333333'
const COPY = 'Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2999.'
const json = (method, body) => new Request('http://localhost/api/x', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const props = { params: Promise.resolve({ id: BC }) }
const put = (body) => PUT(json('PUT', body), props)
const FUTURE = '2999-01-01T09:00:00.000Z'

let tables
const row = () => tables.whatsapp_broadcasts[0]
const manager = () => person({ [LOC_A]: { role: 'manager' } }, LOC_A)
const orgAdmin = () => {
  const p = person({ [LOC_A]: { role: 'manager' } }, LOC_A)
  return { ...p, id: ADMIN_ID, orgAdminOrgIds: [p.locations[0].organization_id] }
}
function world(until) {
  const orgId = manager().locations[0].organization_id
  tables = {
    locations: [{ id: LOC_A, name: 'UN1T Hatch Street', organization_id: orgId, timezone: 'Europe/Dublin',
      settings: until ? { whatsapp_blast_signoff_until: until } : {} }],
    whatsapp_templates: [{ id: TPL, location_id: LOC_A }],
    whatsapp_broadcasts: [{
      id: BC, location_id: LOC_A, status: 'draft', scheduled_at: null, name: 'Launch', delivery_mode: 'blast',
      template_id: TPL, variable_mapping: { 1: 'first_name' }, header_media_url: null,
      audience_filter: { filters: [], logic: 'and' }, signed_off_by: null, signed_off_at: null, paused_at: null,
    }],
  }
  db = makeFakeDb(tables)
}

beforeEach(() => {
  vi.clearAllMocks()
  world('2999-11-16')
})

describe('PUT …/[id] — scheduling inside the sign-off window', () => {
  it('manager gets 403 with the copy while the window is open', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await put({ status: 'scheduled', scheduled_at: FUTURE })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: COPY, signoff_required: true })
    expect(row().status).toBe('draft')
  })
  it("an org admin's schedule stamps the sign-off", async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    const res = await put({ status: 'scheduled', scheduled_at: FUTURE })
    expect(res.status).toBe(200)
    expect(row()).toMatchObject({ status: 'scheduled', signed_off_by: ADMIN_ID, signed_off_at: expect.any(String) })
  })
  it('admin sign-off on a draft lets a manager schedule it (the cron then sends it)', async () => {
    row().signed_off_by = ADMIN_ID
    getCurrentUser.mockResolvedValue(manager())
    const res = await put({ status: 'scheduled', scheduled_at: FUTURE })
    expect(res.status).toBe(200)
    expect(row()).toMatchObject({ status: 'scheduled', signed_off_by: ADMIN_ID })
  })
  it('window past → no gate', async () => {
    world('2020-01-01')
    getCurrentUser.mockResolvedValue(manager())
    expect((await put({ status: 'scheduled', scheduled_at: FUTURE })).status).toBe(200)
  })
})

describe('PUT …/[id] — a content change clears the sign-off', () => {
  it("a manager's audience change clears it", async () => {
    row().signed_off_by = ADMIN_ID
    getCurrentUser.mockResolvedValue(manager())
    const res = await put({ audience_filter: { filters: [{ field: 'tags', op: 'contains', value: 'vip' }], logic: 'and' } })
    expect(res.status).toBe(200)
    expect(row().signed_off_by).toBeNull()
  })
  it("re-saving the same content (the editor's Save before Send) keeps it, whatever the key order", async () => {
    row().signed_off_by = ADMIN_ID
    getCurrentUser.mockResolvedValue(manager())
    const res = await put({ name: 'Launch!', template_id: TPL, variable_mapping: { 1: 'first_name' }, header_media_url: null,
      audience_filter: { logic: 'and', filters: [] } })
    expect(res.status).toBe(200)
    expect(row().signed_off_by).toBe(ADMIN_ID)
  })
  it("a change then a schedule in one request by a manager is refused", async () => {
    row().signed_off_by = ADMIN_ID
    getCurrentUser.mockResolvedValue(manager())
    const res = await put({ variable_mapping: { 1: 'name' }, status: 'scheduled', scheduled_at: FUTURE })
    expect(res.status).toBe(403)
    expect(row()).toMatchObject({ status: 'draft', signed_off_by: ADMIN_ID })
  })
  it("an org admin's change keeps it", async () => {
    row().signed_off_by = ADMIN_ID
    getCurrentUser.mockResolvedValue(orgAdmin())
    await put({ variable_mapping: { 1: 'name' } })
    expect(row().signed_off_by).toBe(ADMIN_ID)
  })
  it("a manager raising a signed drip's pace clears it", async () => {
    Object.assign(row(), { delivery_mode: 'drip', daily_cap: 50, signed_off_by: ADMIN_ID })
    getCurrentUser.mockResolvedValue(manager())
    expect((await put({ daily_cap: 100000 })).status).toBe(200)
    expect(row()).toMatchObject({ daily_cap: 100000, signed_off_by: null })
  })
  it('a manager cannot change a running send’s content inside the window (409, nothing written)', async () => {
    Object.assign(row(), { status: 'sending', signed_off_by: ADMIN_ID })
    getCurrentUser.mockResolvedValue(manager())
    const res = await put({ variable_mapping: { 1: 'name' } })
    expect(res.status).toBe(409)
    expect(row()).toMatchObject({ variable_mapping: { 1: 'first_name' }, signed_off_by: ADMIN_ID })
  })
  it('a name-only change is not gated', async () => {
    Object.assign(row(), { status: 'sending', signed_off_by: ADMIN_ID })
    getCurrentUser.mockResolvedValue(manager())
    expect((await put({ name: 'Renamed' })).status).toBe(200)
    expect(row().signed_off_by).toBe(ADMIN_ID)
  })
  it('outside the window nothing is cleared', async () => {
    world('2020-01-01')
    row().signed_off_by = ADMIN_ID
    getCurrentUser.mockResolvedValue(manager())
    await put({ variable_mapping: { 1: 'name' } })
    expect(row().signed_off_by).toBe(ADMIN_ID)
  })
})

describe('POST /api/whatsapp/broadcasts — create as scheduled', () => {
  const create = () => CREATE(json('POST', { name: 'New', template_id: TPL, location_id: LOC_A,
    audience_filter: { filters: [], logic: 'and' }, status: 'scheduled', scheduled_at: FUTURE }))
  it('manager gets 403 with the copy; nothing is created', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await create()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe(COPY)
    expect(tables.whatsapp_broadcasts).toHaveLength(1)
  })
  it("an org admin's scheduled create is signed off", async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    const res = await create()
    expect(res.status).toBe(200)
    expect(tables.whatsapp_broadcasts.at(-1)).toMatchObject({ status: 'scheduled', signed_off_by: ADMIN_ID })
  })
  it('a draft is never gated', async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await CREATE(json('POST', { name: 'New', template_id: TPL, location_id: LOC_A, audience_filter: { filters: [], logic: 'and' } }))
    expect(res.status).toBe(200)
  })
})

describe('POST …/[id]/pause — resuming a drip', () => {
  const pause = (paused) => PAUSE(json('POST', { paused }), props)
  beforeEach(() => { Object.assign(row(), { delivery_mode: 'drip', status: 'sending', paused_at: '2026-10-18T09:00:00.000Z' }) })
  it("unsigned drip: a manager's resume is a 403 and it stays paused", async () => {
    getCurrentUser.mockResolvedValue(manager())
    const res = await pause(false)
    expect(res.status).toBe(403)
    expect(row().paused_at).not.toBeNull()
  })
  it("an org admin's resume signs it off", async () => {
    getCurrentUser.mockResolvedValue(orgAdmin())
    expect((await pause(false)).status).toBe(200)
    expect(row()).toMatchObject({ paused_at: null, signed_off_by: ADMIN_ID })
  })
  it('a pause is never gated', async () => {
    row().paused_at = null
    getCurrentUser.mockResolvedValue(manager())
    expect((await pause(true)).status).toBe(200)
  })
})
