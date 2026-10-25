// WACONFIGFALLBACK.1 — DELETE /api/whatsapp/templates/[id] deletes at Meta on
// the TEMPLATE's location's own WABA, never the global env one.
//
// Meta deletes by NAME on a WABA. The route named no location, so a template
// row at ANY location deleted the env number's template of the same name.
// A location with no number has no WABA of its own: the Meta call is skipped
// and only the local row goes. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1' })),
  assertLocationAccessOr404: vi.fn(() => null),
  // WATPLROLE.1 (C79) — the role gate has its own tests (route.role.test.js);
  // these pin the NUMBER, so the caller passes it.
  hasRoleAtLocation: vi.fn(() => true),
}))
// GATES-3 (b) — the gate (role AND `whatsapp` at the template's studio) has its
// own tests (route.role.test.js, tests/role-sweep/gates3-routes.test.js).
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn(() => true) }))
vi.mock('@/lib/whatsapp', () => ({ deleteTemplate: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn(), getLocationNumberForWaba: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { DELETE } from './route.js'
import { deleteTemplate as deleteMetaTemplate } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig, getLocationNumberForWaba } from '@/lib/whatsapp-config'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }

let templateRow
function makeDb() {
  const deletes = []
  return {
    deletes,
    from: (table) => {
      let mode = 'read'
      const b = {
        select: () => b,
        delete: () => { mode = 'delete'; return b },
        eq: (_col, val) => { if (mode === 'delete') deletes.push({ table, id: val }); return b },
        single: async () => ({ data: templateRow, error: null }),
        then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
      }
      return b
    },
  }
}

const call = () => DELETE(new Request('https://crm.test/api/whatsapp/templates/t1', { method: 'DELETE' }), { params: Promise.resolve({ id: 't1' }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  templateRow = { name: 'promo_x', location_id: LOC }
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  deleteMetaTemplate.mockResolvedValue({ success: true })
})

describe('DELETE — Meta delete on the template’s own location’s WABA', () => {
  it('with a number: Meta delete uses THAT config, then the row goes', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(deleteMetaTemplate).toHaveBeenCalledWith('promo_x', { config: NUMBER })
    expect(db.deletes).toEqual([{ table: 'whatsapp_templates', id: 't1' }])
  })

  it('no number: Meta is NOT called (no WABA of its own), the local row still goes', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(200)
    expect(deleteMetaTemplate).not.toHaveBeenCalled()
    expect(db.deletes).toEqual([{ table: 'whatsapp_templates', id: 't1' }])
  })

  it('a failed number lookup: 500 and the row is KEPT (a retry can still reach Meta)', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    const res = await call()
    expect(res.status).toBe(500)
    expect(deleteMetaTemplate).not.toHaveBeenCalled()
    expect(db.deletes).toEqual([])
  })
})

// WAORGNUMBER.2 (R5) — a studio can use numbers on two WABAs; Meta deletes by
// name on one, so the delete runs on the template's OWN WABA.
describe('WAORGNUMBER.2 — the template’s own WABA', () => {
  const ON_WABA_2 = { ...NUMBER, id: 'n2', phoneNumberId: 'PNI-2', businessAccountId: 'WABA-2' }

  it('delete runs on the template’s own WABA', async () => {
    templateRow = { name: 'promo_x', location_id: LOC, business_account_id: 'WABA-2' }
    getLocationNumberForWaba.mockResolvedValue(ON_WABA_2)
    const res = await call()
    expect(res.status).toBe(200)
    expect(getLocationNumberForWaba).toHaveBeenCalledWith(LOC, 'WABA-2')
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
    expect(deleteMetaTemplate).toHaveBeenCalledWith('promo_x', { config: ON_WABA_2 })
    expect(db.deletes).toEqual([{ table: 'whatsapp_templates', id: 't1' }])
  })

  it('its WABA has no number switched on at the studio: 409, Meta not called, the row KEPT', async () => {
    templateRow = { name: 'promo_x', location_id: LOC, business_account_id: 'WABA-2' }
    getLocationNumberForWaba.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'The number this template lives on is switched off at this studio.' })
    expect(deleteMetaTemplate).not.toHaveBeenCalled()
    expect(db.deletes).toEqual([])
  })

  it('a failed lookup on its WABA: 500, the row kept', async () => {
    templateRow = { name: 'promo_x', location_id: LOC, business_account_id: 'WABA-2' }
    getLocationNumberForWaba.mockRejectedValue(new Error('db down'))
    const res = await call()
    expect(res.status).toBe(500)
    expect(db.deletes).toEqual([])
  })
})
