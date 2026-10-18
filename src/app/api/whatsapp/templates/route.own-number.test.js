// WACONFIGFALLBACK.1 — template create (POST) and sync (GET ?sync=true) act
// on the location's OWN WhatsApp Business Account, never the global env one.
//
// Before: the create called Meta with no location at all (so every template
// was submitted on the env number's WABA, whatever location it was saved
// under), and the sync resolved by location id, which fell back to the env
// number at a location with none and copied that WABA's templates into this
// location's rows.
//
// WAORGNUMBER.2 (R5) — a number belongs to the organisation and several studios
// can use one WABA. The create goes on the WABA of the studio's default number,
// refuses a name another studio already uses there (naming the owner), and
// stores business_account_id. The sync walks each WABA of the studio's
// switched-on numbers, reads every page, updates the studio's own rows, skips
// other studios' and adopts unowned templates only at the number's home studio.
// Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1', activeLocation: { id: 'a0000000-0000-4000-8000-000000000001' } })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['a0000000-0000-4000-8000-000000000001']),
  // WATPLROLE.1 (C79) — the role gate has its own tests (route.role.test.js);
  // these pin the NUMBER, so the caller passes it.
  hasRoleAtLocation: vi.fn(() => true),
}))
// GATES-3 (b) — the gate (role AND `whatsapp` at the template's studio) has its
// own tests (route.role.test.js, tests/role-sweep/gates3-routes.test.js).
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn(() => true) }))
vi.mock('@/lib/whatsapp', () => ({ createTemplate: vi.fn(), getTemplates: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn(), listLocationNumberConfigs: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, POST } from './route.js'
import { createTemplate as createMetaTemplate, getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig, listLocationNumberConfigs } from '@/lib/whatsapp-config'
import { createServerClient } from '@/lib/supabase'
import { fakeTemplatesDb } from './templates-fake-db.test-helpers.js'

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const LOC = STILL
// The organisation number: home Stillorgan, on WABA-ORG.
const NUMBER = { source: 'db', id: 'n1', locationId: STILL, homeLocationId: STILL, phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-ORG' }
const atHatch = { ...NUMBER, locationId: HATCH }
const CACHED = { id: 'row-1', name: 'book_first_visit', language: 'en', status: 'APPROVED', location_id: STILL, business_account_id: 'WABA-ORG', meta_template_id: 'meta-1' }
const meta = (id, name, extra = {}) => ({ id, name, language: 'en', category: 'MARKETING', components: [], status: 'APPROVED', ...extra })

let state
beforeEach(() => {
  vi.clearAllMocks()
  state = {
    whatsapp_templates: [{ ...CACHED }],
    locations: [{ id: STILL, name: 'UN1T Stillorgan' }, { id: HATCH, name: 'UN1T Hatch Street' }],
    faults: {},
  }
  createServerClient.mockImplementation(() => fakeTemplatesDb(state))
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  listLocationNumberConfigs.mockResolvedValue([NUMBER])
  getMetaTemplates.mockResolvedValue([])
  createMetaTemplate.mockResolvedValue({ id: 'meta-new', status: 'PENDING' })
})

const syncReq = (loc = LOC) => ({ url: `https://crm.test/api/whatsapp/templates?location_id=${loc}&sync=true` })
const createReq = (extra = {}) => new Request('https://crm.test/api/whatsapp/templates', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'promo_x', category: 'MARKETING', language: 'en', components: [{ type: 'BODY', text: 'Hi' }], location_id: LOC, ...extra }),
})
const writesTo = (op) => state.writes.filter((w) => w.table === 'whatsapp_templates' && w.op === op)

describe('GET ?sync=true — the location’s own WABA only', () => {
  it('with a number: Meta is read with THAT config, every page (never re-resolved by location id)', async () => {
    const body = await (await GET(syncReq())).json()
    expect(body.sync_error).toBeNull()
    expect(listLocationNumberConfigs).toHaveBeenCalledWith(LOC)
    expect(getMetaTemplates).toHaveBeenCalledWith(100, { config: NUMBER, all: true })
  })

  it('no number: sync_error says so, Meta never called, nothing written, the cache still served', async () => {
    listLocationNumberConfigs.mockResolvedValue([])
    const body = await (await GET(syncReq())).json()
    expect(body.success).toBe(true)
    expect(body.sync_error).toBe('No WhatsApp number is connected at this location.')
    expect(body.templates).toEqual([CACHED])
    expect(getMetaTemplates).not.toHaveBeenCalled()
    expect(state.writes).toEqual([])
  })

  it('a failed number lookup: sync_error, Meta never called', async () => {
    listLocationNumberConfigs.mockRejectedValue(new Error('db down'))
    const body = await (await GET(syncReq())).json()
    expect(body.sync_error).toBe("Could not check this location's WhatsApp number just now.")
    expect(getMetaTemplates).not.toHaveBeenCalled()
  })
})

describe('WAORGNUMBER.2 — sync per WABA', () => {
  it('sync reads every page', async () => {
    await GET(syncReq())
    expect(getMetaTemplates).toHaveBeenCalledTimes(1)
    expect(getMetaTemplates.mock.calls[0][1]).toMatchObject({ all: true })
  })

  it('sync at Hatch does not copy Stillorgan templates', async () => {
    // Hatch uses Stillorgan's number (home Stillorgan). Meta lists Stillorgan's
    // template plus one made in Meta's UI that no studio owns.
    listLocationNumberConfigs.mockResolvedValue([atHatch])
    getMetaTemplates.mockResolvedValue([meta('meta-1', 'book_first_visit'), meta('meta-ui', 'made_in_meta')])
    const body = await (await GET(syncReq(HATCH))).json()
    expect(body.sync_error).toBeNull()
    expect(writesTo('insert')).toEqual([])
    expect(writesTo('update')).toEqual([])
    expect(state.whatsapp_templates.filter((r) => r.location_id === HATCH)).toEqual([])
  })

  it('sync at the number’s home studio updates its own rows and adopts an unowned template', async () => {
    getMetaTemplates.mockResolvedValue([meta('meta-1', 'book_first_visit', { status: 'PAUSED' }), meta('meta-ui', 'made_in_meta')])
    const body = await (await GET(syncReq(STILL))).json()
    expect(body.sync_error).toBeNull()
    expect(writesTo('update')).toEqual([expect.objectContaining({ id: 'row-1', patch: expect.objectContaining({ status: 'PAUSED', location_id: STILL, business_account_id: 'WABA-ORG' }) })])
    expect(writesTo('insert').map((w) => w.row)).toEqual([expect.objectContaining({ name: 'made_in_meta', location_id: STILL, business_account_id: 'WABA-ORG', meta_template_id: 'meta-ui' })])
  })

  it('sync at Hatch updates Hatch’s own rows on the shared WABA', async () => {
    state.whatsapp_templates.push({ id: 'row-h', name: 'hatch_offer', language: 'en', status: 'PENDING', location_id: HATCH, business_account_id: 'WABA-ORG', meta_template_id: 'meta-h' })
    listLocationNumberConfigs.mockResolvedValue([atHatch])
    getMetaTemplates.mockResolvedValue([meta('meta-1', 'book_first_visit'), meta('meta-h', 'hatch_offer')])
    await GET(syncReq(HATCH))
    expect(writesTo('update')).toEqual([expect.objectContaining({ id: 'row-h', patch: expect.objectContaining({ status: 'APPROVED', location_id: HATCH }) })])
    expect(writesTo('insert')).toEqual([])
  })

  it('a studio on two WABAs syncs each once, with the first number on it', async () => {
    const second = { ...NUMBER, id: 'n2', phoneNumberId: 'PNI-2', businessAccountId: 'WABA-2' }
    const sameWaba = { ...NUMBER, id: 'n3', phoneNumberId: 'PNI-3' }
    listLocationNumberConfigs.mockResolvedValue([NUMBER, second, sameWaba])
    await GET(syncReq())
    expect(getMetaTemplates.mock.calls.map((c) => c[1].config.id)).toEqual(['n1', 'n2'])
  })

  it('one WABA failing at Meta still syncs the other, and says which failed', async () => {
    const second = { ...NUMBER, id: 'n2', phoneNumberId: 'PNI-2', businessAccountId: 'WABA-2' }
    listLocationNumberConfigs.mockResolvedValue([NUMBER, second])
    getMetaTemplates.mockImplementation(async (_l, { config }) => {
      if (config.id === 'n1') throw new Error('Invalid OAuth access token')
      return [meta('meta-2', 'second_waba_tpl')]
    })
    const body = await (await GET(syncReq())).json()
    expect(body.sync_error).toBe('Invalid OAuth access token')
    expect(writesTo('insert').map((w) => w.row)).toEqual([expect.objectContaining({ name: 'second_waba_tpl', business_account_id: 'WABA-2' })])
  })

  it('a row of this studio saved before its WABA was recorded is stamped by Meta’s id, not duplicated', async () => {
    state.whatsapp_templates = [{ ...CACHED, business_account_id: null }]
    getMetaTemplates.mockResolvedValue([meta('meta-1', 'book_first_visit')])
    await GET(syncReq())
    expect(writesTo('insert')).toEqual([])
    expect(writesTo('update')).toEqual([expect.objectContaining({ id: 'row-1', patch: expect.objectContaining({ business_account_id: 'WABA-ORG' }) })])
  })
})

describe('POST — create on the location’s own WABA only', () => {
  it('with a number: submitted with THAT config, row saved under the location', async () => {
    const res = await POST(createReq())
    expect(res.status).toBe(200)
    expect(createMetaTemplate).toHaveBeenCalledTimes(1)
    expect(createMetaTemplate.mock.calls[0][1]).toEqual({ config: NUMBER })
    expect(writesTo('insert')[0].row).toMatchObject({ name: 'promo_x', location_id: LOC, meta_template_id: 'meta-new' })
  })

  it('create stores business_account_id', async () => {
    const res = await POST(createReq())
    expect(res.status).toBe(200)
    expect(writesTo('insert')[0].row).toMatchObject({ business_account_id: 'WABA-ORG' })
  })

  it('create refuses a name used by another studio on the WABA with the owner’s name', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(atHatch)
    const res = await POST(createReq({ name: 'book_first_visit', location_id: HATCH }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      success: false,
      error: 'That name is already used by UN1T Stillorgan on this WhatsApp account. Pick another name.',
    })
    expect(createMetaTemplate).not.toHaveBeenCalled()
    expect(writesTo('insert')).toEqual([])
  })

  it('another studio’s name in ANOTHER language is still refused (Meta keys one template per name)', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(atHatch)
    const res = await POST(createReq({ name: 'book_first_visit', language: 'ga', location_id: HATCH }))
    expect(res.status).toBe(409)
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })

  it('the studio’s own name in a new language is allowed (a translation)', async () => {
    const res = await POST(createReq({ name: 'book_first_visit', language: 'ga' }))
    expect(res.status).toBe(200)
    expect(createMetaTemplate).toHaveBeenCalledTimes(1)
  })

  it('the same name on ANOTHER WABA is not a clash', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue({ ...atHatch, businessAccountId: 'WABA-HATCH' })
    const res = await POST(createReq({ name: 'book_first_visit', location_id: HATCH }))
    expect(res.status).toBe(200)
    expect(writesTo('insert')[0].row).toMatchObject({ location_id: HATCH, business_account_id: 'WABA-HATCH' })
  })

  it('a failed name check: 500, Meta never called', async () => {
    state.faults['whatsapp_templates:select'] = { message: 'timeout' }
    const res = await POST(createReq())
    expect(res.status).toBe(500)
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })

  it('no number: 409, Meta never called, nothing saved', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const res = await POST(createReq())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(createMetaTemplate).not.toHaveBeenCalled()
    expect(state.writes ?? []).toEqual([])
  })

  it('a failed number lookup: 500, Meta never called', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    const res = await POST(createReq())
    expect(res.status).toBe(500)
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })
})
