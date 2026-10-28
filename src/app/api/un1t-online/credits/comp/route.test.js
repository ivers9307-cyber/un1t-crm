// UN1TCOMP.1 — POST /api/un1t-online/credits/comp (staff add complimentary
// un1t.online credits) and the class list's `comp` block (the permission and
// the "given" list) that the Hatch card reads.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => ({ ...(await vi.importActual('@/lib/auth')), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/location-time', async (o) => ({ ...(await o()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/un1t-online-settings', async (o) => ({ ...(await o()), readUn1tWriteSettings: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', () => ({ grantCompCredits: vi.fn(), book: vi.fn(), cancel: vi.fn(), moveBooking: vi.fn() }))
vi.mock('@/lib/book-chat-copy', async (o) => ({ ...(await o()), readCompChatTemplate: vi.fn(async () => ({ template: null, error: null })) }))

import { POST, maxDuration } from './route.js'
import { GET as CLASSES } from '../../classes/route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getLocationZone, LocationZoneReadError } from '@/lib/location-time'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'
import { grantCompCredits } from '@/lib/un1t-online-write-ops'
import { readCompChatTemplate } from '@/lib/book-chat-copy'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'

const HATCH = 'a0000000-0000-4000-8000-000000000002'
const C1 = 'c0000000-0000-4000-8000-000000000001'
const REQ = 'd0000000-0000-4000-8000-000000000001'
const userAt = (role, { template = null, permissions = {}, loc = HATCH } = {}) => ({
  id: `u-${role}`, role, isMaster: role === 'master',
  locations: [{ id: loc, role }], rolesByLocation: { [loc]: role },
  assignmentsByLocation: { [loc]: { role, permissions } },
  roleTemplatesByLocation: template ? { [loc]: template } : {},
  activeLocation: { id: loc },
})

let tables
function makeDb() {
  return {
    from(table) {
      const f = []
      const rows = () => (tables[table] || []).filter((r) => f.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'gt' ? r[c] > v : k === 'lte' ? r[c] <= v : true)))
      const b = {
        select: () => b, order: () => b, limit: () => b, range: () => b,
        eq: (c, v) => { f.push(['eq', c, v]); return b },
        in: (c, v) => { f.push(['in', c, v]); return b },
        gt: (c, v) => { f.push(['gt', c, v]); return b },
        gte: () => b,
        lte: (c, v) => { f.push(['lte', c, v]); return b },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok, no) => Promise.resolve({ data: rows(), error: null }).then(ok, no),
      }
      return b
    },
  }
}

// 28 Oct 2026, midday at the studio: tomorrow is the 29th.
const NOW = new Date('2026-10-28T12:00:00Z')
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  getCurrentUser.mockResolvedValue(userAt('reception'))
  readUn1tWriteSettings.mockResolvedValue({ membershipSource: 'un1t_online', studioName: 'UN1T Hatch Street', organizationId: 'org-1', settings: { writesEnabled: true } })
  tables = {
    contacts: [{ id: C1, organization_id: 'org-1', name: 'Test', un1t_user_id: 'usr-1' }],
    un1t_clients: [{ id: 'cl-1', location_id: HATCH, un1t_user_id: 'usr-1', credit_balance: 2, credit_unlimited: false, crm_written_at: null, synced_at: '2026-10-28T08:00:00.000Z' }],
    un1t_events: [],
    un1t_bookings: [],
    un1t_sync_runs: [],
    un1t_write_events: [],
    profiles: [{ id: 'u-owner', full_name: 'Aoife Byrne' }],
  }
  createServerClient.mockReturnValue(makeDb())
  grantCompCredits.mockResolvedValue({ verdict: 'done', sent: true, id: 'batch-9', code: null, message: null, ledgerId: 'l-1', recovered: null, data: { expires_at: '2026-11-05T12:00:03.000Z', original_amount: 2 } })
})

const body = (over = {}) => ({ contact_id: C1, location_id: HATCH, request_id: REQ, amount: 2, use_by: '2026-11-05', reason: 'goodwill', note: 'Sorry about Tuesday', ...over })
const post = (over) => POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(over)) }))

describe('POST /api/un1t-online/credits/comp', () => {
  it('leaves room for a check read (maxDuration 120)', () => {
    expect(maxDuration).toBe(120)
  })

  it('done: grantCompCredits with origin staff, the actor and expiresInDays counted on the studio clock; un1t.online\'s expiry comes back', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toMatchObject({ batch_id: 'batch-9', expires_at: '2026-11-05T12:00:03.000Z', amount: 2, use_by: '2026-11-05', chat_template: null })
    expect(j.data.message).toBe('Added 2 credits in un1t.online, usable until Thu 5 Nov.')
    expect(grantCompCredits.mock.calls[0][1]).toEqual({
      locationId: HATCH, contactId: C1, un1tUserId: 'usr-1', amount: 2, expiresInDays: 8, useBy: '2026-11-05',
      reason: 'goodwill', note: 'Sorry about Tuesday', requestId: REQ, origin: 'staff', actor: { id: 'u-reception' },
    })
  })

  it('the day count follows the studio\'s zone, not UTC: 23:30Z on the 28th is the 29th in a zone east of UTC', async () => {
    vi.setSystemTime(new Date('2026-10-28T23:30:00Z'))
    getLocationZone.mockResolvedValueOnce('Europe/Helsinki')
    await post()
    expect(grantCompCredits.mock.calls[0][1].expiresInDays).toBe(7)
    getLocationZone.mockResolvedValueOnce('America/New_York')
    await post()
    expect(grantCompCredits.mock.calls[1][1].expiresInDays).toBe(8)
  })

  it('hands the studio\'s editable message back for the open chat', async () => {
    readCompChatTemplate.mockResolvedValueOnce({ template: 'Added {credits}!', error: null })
    const j = await (await post()).json()
    expect(j.data.chat_template).toBe('Added {credits}!')
  })

  it('owner, manager and reception may; head coach and staff are refused 403 and nothing is sent', async () => {
    for (const role of ['owner', 'manager', 'reception', 'master']) {
      getCurrentUser.mockResolvedValue(userAt(role))
      expect((await post()).status, role).toBe(200)
    }
    grantCompCredits.mockClear()
    for (const role of ['head_coach', 'staff']) {
      getCurrentUser.mockResolvedValue(userAt(role))
      const res = await post()
      expect(res.status, role).toBe(403)
      expect((await res.json()).error).toBe('You do not have permission to add complimentary credits at this studio.')
    }
    expect(grantCompCredits).not.toHaveBeenCalled()
  })

  it('a role template at the studio is honoured: reception switched off, head coach switched on', async () => {
    getCurrentUser.mockResolvedValue(userAt('reception', { template: { un1t_comp_credits: false } }))
    expect((await post()).status).toBe(403)
    getCurrentUser.mockResolvedValue(userAt('head_coach', { template: { un1t_comp_credits: true } }))
    expect((await post()).status).toBe(200)
  })

  it('an owner at another studio only is refused 403', async () => {
    getCurrentUser.mockResolvedValue(userAt('owner', { loc: 'a0000000-0000-4000-8000-000000000009' }))
    expect((await post()).status).toBe(403)
    expect(grantCompCredits).not.toHaveBeenCalled()
  })

  it('a contact outside the studio\'s organisation is 404, nothing sent', async () => {
    tables.contacts[0].organization_id = 'org-other'
    expect((await post()).status).toBe(404)
    expect(grantCompCredits).not.toHaveBeenCalled()
  })

  it('writes switched off at the studio is refused in staff words before anything is sent', async () => {
    readUn1tWriteSettings.mockResolvedValue({ membershipSource: 'un1t_online', studioName: 'UN1T Hatch Street', organizationId: 'org-1', settings: { writesEnabled: false } })
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('un1t.online writes are off at UN1T Hatch Street, so no credits were added.')
    expect(grantCompCredits).not.toHaveBeenCalled()
  })

  it('the limits are the server\'s: amount 1 to 10, a reason from the list, a note of 200 plain characters, a use-by day from tomorrow to a year ahead', async () => {
    for (const over of [
      { amount: 0 }, { amount: 11 }, { amount: 2.5 }, { amount: '2' },
      { reason: 'because' }, { reason: undefined },
      { note: 'x'.repeat(201) }, { note: 'mail jo@example.com' }, { note: 'ring 087 123 4567' },
      { use_by: '2026-10-28' }, { use_by: '2026-10-20' }, { use_by: '2027-10-29' }, { use_by: '2026-02-30' }, { use_by: '5 Nov' },
      { request_id: 'nope' }, { contact_id: 'x' },
    ]) {
      expect((await post(over)).status, JSON.stringify(over)).toBe(400)
    }
    expect(grantCompCredits).not.toHaveBeenCalled()
    expect((await post({ use_by: '2026-10-29', amount: 10, note: null })).status).toBe(200)
    expect((await post({ use_by: '2027-10-28', amount: 1, reason: 'other', note: undefined })).status).toBe(200)
  })

  it('unknown is a 502 telling staff to check un1t.online; the busy budget a 429; a refusal a 409 with un1t.online\'s words', async () => {
    grantCompCredits.mockResolvedValueOnce({ verdict: 'unknown', sent: true, id: null, code: null, ledgerId: 'l-2' })
    let res = await post()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Check the client in un1t.online/)
    grantCompCredits.mockResolvedValueOnce({ verdict: 'refused', sent: false, code: 'UN1T_RATE_BUDGET', message: 'x' })
    expect((await post()).status).toBe(429)
    grantCompCredits.mockResolvedValueOnce({ verdict: 'refused', sent: true, code: 'USER_NOT_FOUND', message: 'No such user', ledgerId: 'l-3' })
    res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('No such user')
  })

  it('an unreadable studio clock or settings is a 503, nothing sent', async () => {
    getLocationZone.mockRejectedValueOnce(new LocationZoneReadError('boom'))
    expect((await post()).status).toBe(503)
    expect(grantCompCredits).not.toHaveBeenCalled()
    grantCompCredits.mockRejectedValueOnce(new Un1tSettingsReadError('boom'))
    expect((await post()).status).toBe(503)
  })
})

describe('GET /api/un1t-online/classes — the comp block', () => {
  const get = () => CLASSES(new Request(`http://x/api/un1t-online/classes?location_id=${HATCH}&contact_id=${C1}`))

  it('can_grant follows the permission at the studio; the zone is the studio\'s', async () => {
    let j = await (await get()).json()
    expect(j.data.comp.can_grant).toBe(true)
    expect(j.data.zone).toBe('Europe/Dublin')
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    j = await (await get()).json()
    expect(j.data.comp.can_grant).toBe(false)
  })

  it('lists this person\'s done and in-doubt grants at this studio, newest first, with who gave them (first name)', async () => {
    tables.un1t_write_events = [
      { id: 'w-1', location_id: HATCH, op: 'comp_credits', un1t_user_id: 'usr-1', stage: 'done', created_at: '2026-10-20T10:00:00Z', actor_user_id: 'u-owner', comp_amount: 2, comp_reason: 'injury', comp_use_by: '2026-10-27', comp_expires_at: '2026-10-27T10:00:01Z' },
      { id: 'w-2', location_id: HATCH, op: 'comp_credits', un1t_user_id: 'usr-1', stage: 'unknown', created_at: '2026-10-25T10:00:00Z', actor_user_id: 'u-gone', comp_amount: 1, comp_reason: 'goodwill', comp_use_by: '2026-11-01', comp_expires_at: null },
      { id: 'w-3', location_id: HATCH, op: 'comp_credits', un1t_user_id: 'usr-1', stage: 'refused', created_at: '2026-10-26T10:00:00Z', actor_user_id: 'u-owner', comp_amount: 3, comp_reason: 'goodwill', comp_use_by: '2026-11-01' },
      { id: 'w-4', location_id: HATCH, op: 'comp_credits', un1t_user_id: 'usr-2', stage: 'done', created_at: '2026-10-26T10:00:00Z', actor_user_id: 'u-owner', comp_amount: 3, comp_reason: 'goodwill', comp_use_by: '2026-11-01' },
      { id: 'w-5', location_id: 'other', op: 'comp_credits', un1t_user_id: 'usr-1', stage: 'done', created_at: '2026-10-26T10:00:00Z', actor_user_id: 'u-owner', comp_amount: 3, comp_reason: 'goodwill', comp_use_by: '2026-11-01' },
      { id: 'w-6', location_id: HATCH, op: 'book', un1t_user_id: 'usr-1', stage: 'done', created_at: '2026-10-26T10:00:00Z' },
    ]
    const j = await (await get()).json()
    expect(j.data.comp.given.map((g) => g.id).sort()).toEqual(['w-1', 'w-2'])
    expect(j.data.comp.given.find((g) => g.id === 'w-1')).toEqual({
      id: 'w-1', at: '2026-10-20T10:00:00Z', amount: 2, reason: 'Injury', use_by: '2026-10-27', expires_at: '2026-10-27T10:00:01Z', by: 'Aoife', confirmed: true,
    })
    expect(j.data.comp.given.find((g) => g.id === 'w-2')).toMatchObject({ by: null, confirmed: false })
  })
})
