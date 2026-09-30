// WATPLROLE.1 — POST /api/whatsapp/templates creates a template AND submits it
// to Meta for review on the studio's WhatsApp Business Account. It decided on
// membership alone, so any staff member at a studio could put a template in
// front of Meta under the studio's name, while resubmitting a rejected one
// already needed MANAGER_ROLES at the template's location. Create now uses
// that rule, at the location it creates at (body location_id, else the
// active studio), before Meta or the database is touched.
//
// Written to pass whether or not C81 WACONFIGFALLBACK.1 (the location's own
// number) is on main: '@/lib/whatsapp-config' is mocked with a number, and
// the Meta call is checked on its FIRST argument only. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/whatsapp', () => ({ createTemplate: vi.fn(), getTemplates: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createTemplate as createMetaTemplate } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { LOC_A, LOC_B, person, MASTER } from '../../../../../tests/helpers/owner-at-location-callers.js'

const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }
const FORBIDDEN = { success: false, error: 'Forbidden' }

function makeDb() {
  const inserts = []
  return {
    inserts,
    from: (table) => {
      const b = {
        insert: (row) => { inserts.push({ table, row }); return b },
        select: () => b,
        single: async () => ({ data: { id: 'row-new', ...inserts.at(-1)?.row }, error: null }),
      }
      return b
    },
  }
}

const create = (extra = {}) => new Request('https://crm.test/api/whatsapp/templates', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'promo_x', category: 'MARKETING', language: 'en', components: [{ type: 'BODY', text: 'Hi' }], ...extra }),
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  createMetaTemplate.mockResolvedValue({ id: 'meta-new', status: 'PENDING' })
})

describe('POST /api/whatsapp/templates — MANAGER_ROLES at the location created at (WATPLROLE.1)', () => {
  it.each([
    ['a manager there', person({ [LOC_B]: 'manager' }, LOC_B)],
    ['a head coach there', person({ [LOC_B]: 'head_coach' }, LOC_B)],
    ['an owner there', person({ [LOC_B]: 'owner' }, LOC_B)],
    ['staff at the active studio, manager at the target', person({ [LOC_A]: 'staff', [LOC_B]: 'manager' }, LOC_A)],
    ['a master', MASTER],
  ])('%s: created and submitted (200)', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await POST(create({ location_id: LOC_B }))
    expect(res.status).toBe(200)
    expect(createMetaTemplate).toHaveBeenCalledTimes(1)
    expect(createMetaTemplate.mock.calls[0][0]).toMatchObject({ name: 'promo_x', category: 'MARKETING' })
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0].row).toMatchObject({ name: 'promo_x', location_id: LOC_B, meta_template_id: 'meta-new' })
  })

  it.each([
    ['staff there', person({ [LOC_B]: 'staff' }, LOC_B)],
    ['reception there', person({ [LOC_B]: 'reception' }, LOC_B)],
    ['a manager at the active studio who is staff at the target', person({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_A)],
  ])('%s: refused (403), Meta and the database never touched', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await POST(create({ location_id: LOC_B }))
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: FORBIDDEN })
    expect(createMetaTemplate).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no location_id: judged at the active studio (a manager there is allowed, staff is not)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'manager' }, LOC_B))
    expect((await POST(create())).status).toBe(200)
    expect(db.inserts[0].row.location_id).toBe(LOC_B)

    vi.clearAllMocks()
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    expect((await POST(create())).status).toBe(403)
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })

  it('no location at all (no body location, no active studio): refused, never submitted with a null location', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_B]: 'manager' }, LOC_B), activeLocation: null })
    const res = await POST(create())
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: FORBIDDEN })
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })

  it('a caller who does not belong to the location keeps the membership answer (403, body location)', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'owner' }, LOC_A))
    const res = await POST(create({ location_id: LOC_B }))
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' },
    })
    expect(createMetaTemplate).not.toHaveBeenCalled()
  })
})
