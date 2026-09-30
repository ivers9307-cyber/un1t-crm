// WACONFIGFALLBACK.1 — template create (POST) and sync (GET ?sync=true) act
// on the location's OWN WhatsApp Business Account, never the global env one.
//
// Before: the create called Meta with no location at all (so every template
// was submitted on the env number's WABA, whatever location it was saved
// under), and the sync resolved by location id, which fell back to the env
// number at a location with none and copied that WABA's templates into this
// location's rows. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1', activeLocation: { id: 'a0000000-0000-4000-8000-000000000001' } })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['a0000000-0000-4000-8000-000000000001']),
  // WATPLROLE.1 (C79) — the role gate has its own tests (route.role.test.js);
  // these pin the NUMBER, so the caller passes it.
  hasRoleAtLocation: vi.fn(() => true),
}))
vi.mock('@/lib/whatsapp', () => ({ createTemplate: vi.fn(), getTemplates: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, POST } from './route.js'
import { createTemplate as createMetaTemplate, getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }
const CACHED = [{ id: 'row-1', name: 'book_first_visit', status: 'APPROVED' }]

function makeDb() {
  const inserts = []
  return {
    inserts,
    from: () => {
      let mode = 'list'
      const b = {
        select: () => b, eq: () => b, in: () => b, order: () => b,
        insert: (row) => { mode = 'insert'; inserts.push(row); return b },
        update: () => { mode = 'write'; return b },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: { id: 'row-new', ...inserts.at(-1) }, error: null }),
        then: (res, rej) => Promise.resolve(mode === 'list' ? { data: CACHED, error: null } : { error: null }).then(res, rej),
      }
      return b
    },
  }
}

const syncReq = () => ({ url: `https://crm.test/api/whatsapp/templates?location_id=${LOC}&sync=true` })
const createReq = () => new Request('https://crm.test/api/whatsapp/templates', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'promo_x', category: 'MARKETING', language: 'en', components: [{ type: 'BODY', text: 'Hi' }], location_id: LOC }),
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  getMetaTemplates.mockResolvedValue([])
  createMetaTemplate.mockResolvedValue({ id: 'meta-new', status: 'PENDING' })
})

describe('GET ?sync=true — the location’s own WABA only', () => {
  it('with a number: Meta is read with THAT config (never re-resolved by location id)', async () => {
    const body = await (await GET(syncReq())).json()
    expect(body.sync_error).toBeNull()
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(getMetaTemplates).toHaveBeenCalledWith(100, { config: NUMBER })
  })

  it('no number: sync_error says so, Meta never called, nothing written, the cache still served', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const body = await (await GET(syncReq())).json()
    expect(body.success).toBe(true)
    expect(body.sync_error).toBe('No WhatsApp number is connected at this location.')
    expect(body.templates).toEqual(CACHED)
    expect(getMetaTemplates).not.toHaveBeenCalled()
    expect(db.inserts).toEqual([])
  })

  it('a failed number lookup: sync_error, Meta never called', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    const body = await (await GET(syncReq())).json()
    expect(body.sync_error).toBe("Could not check this location's WhatsApp number just now.")
    expect(getMetaTemplates).not.toHaveBeenCalled()
  })
})

describe('POST — create on the location’s own WABA only', () => {
  it('with a number: submitted with THAT config, row saved under the location', async () => {
    const res = await POST(createReq())
    expect(res.status).toBe(200)
    expect(createMetaTemplate).toHaveBeenCalledTimes(1)
    expect(createMetaTemplate.mock.calls[0][1]).toEqual({ config: NUMBER })
    expect(db.inserts[0]).toMatchObject({ name: 'promo_x', location_id: LOC, meta_template_id: 'meta-new' })
  })

  it('no number: 409, Meta never called, nothing saved', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const res = await POST(createReq())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(createMetaTemplate).not.toHaveBeenCalled()
    expect(db.inserts).toEqual([])
  })

  it('a failed number lookup: 500, Meta never called', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    const res = await POST(createReq())
    expect(res.status).toBe(500)
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })
})
