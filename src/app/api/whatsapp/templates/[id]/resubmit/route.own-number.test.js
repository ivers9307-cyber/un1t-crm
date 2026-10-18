// WACONFIGFALLBACK.1 — resubmitting a template edits it at Meta with the
// template's location's OWN number. The route named no location, so the edit
// always went out on the global env token. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1' })),
  assertLocationAccessOr404: vi.fn(() => null),
  hasRoleAtLocation: vi.fn(() => true),
}))
// GATES-3 (b) — the gate (role AND `whatsapp` at the template's studio) has its
// own tests (route.role.test.js, tests/role-sweep/gates3-routes.test.js).
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn(() => true) }))
vi.mock('@/lib/whatsapp', () => ({ editTemplate: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn(), getLocationNumberForWaba: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { editTemplate } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig, getLocationNumberForWaba } from '@/lib/whatsapp-config'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }
let TMPL

function makeDb() {
  const updates = []
  return {
    updates,
    from: () => {
      let mode = 'read'
      const b = {
        select: () => b, eq: () => b,
        update: (patch) => { mode = 'update'; updates.push(patch); return b },
        single: async () => (mode === 'update' ? { data: { ...TMPL, ...updates.at(-1) }, error: null } : { data: TMPL, error: null }),
      }
      return b
    },
  }
}

const call = () => POST(new Request('https://crm.test/api/whatsapp/templates/t1/resubmit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ components: [{ type: 'BODY', text: 'Hi again' }] }),
}), { params: Promise.resolve({ id: 't1' }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  TMPL = { id: 't1', location_id: LOC, status: 'REJECTED', meta_template_id: 'meta-1' }
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  editTemplate.mockResolvedValue({ success: true })
})

describe('POST resubmit — the template’s own location’s number', () => {
  it('with a number: Meta edit uses THAT config, row back to PENDING', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(editTemplate).toHaveBeenCalledWith('meta-1', { category: undefined, components: [{ type: 'BODY', text: 'Hi again' }] }, { config: NUMBER })
    expect(db.updates[0]).toMatchObject({ status: 'PENDING' })
  })

  it('no number: 409, Meta never called, row untouched', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'No WhatsApp number is connected at this location.' })
    expect(editTemplate).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
  })
})

// WAORGNUMBER.2 (R5) — the edit runs on the template's OWN WABA.
describe('WAORGNUMBER.2 — resubmit on the template’s own WABA', () => {
  const ON_WABA_2 = { ...NUMBER, id: 'n2', phoneNumberId: 'PNI-2', businessAccountId: 'WABA-2' }

  it('edits with the studio’s number on the template’s WABA', async () => {
    TMPL = { ...TMPL, business_account_id: 'WABA-2' }
    getLocationNumberForWaba.mockResolvedValue(ON_WABA_2)
    const res = await call()
    expect(res.status).toBe(200)
    expect(getLocationNumberForWaba).toHaveBeenCalledWith(LOC, 'WABA-2')
    expect(editTemplate.mock.calls[0][2]).toEqual({ config: ON_WABA_2 })
  })

  it('no number on that WABA at the studio: 409 with the copy, Meta never called, row untouched', async () => {
    TMPL = { ...TMPL, business_account_id: 'WABA-2' }
    getLocationNumberForWaba.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'The number this template lives on is switched off at this studio.' })
    expect(editTemplate).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
  })
})
