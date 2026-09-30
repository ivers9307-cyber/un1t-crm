// WATPLROLE.1 — DELETE and PUT /api/whatsapp/templates/[id] decide with the
// resubmit rule: MANAGER_ROLES AT the template's location.
//
// DELETE removes the template AT META by name (every automation still
// sending it then fails) and PUT could rewrite what a send uses (status,
// components, the header image URL). Both checked membership only, while
// resubmitting a rejected template already needed MANAGER_ROLES there. A PUT
// that changes ONLY display_group (the picker grouping, never sent to Meta)
// stays open to every member: the templates list saves it inline.
//
// Written to pass whether or not C81 WACONFIGFALLBACK.1 is on main:
// '@/lib/whatsapp-config' is mocked with a number, and the Meta delete is
// checked on its FIRST argument only. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/whatsapp', () => ({ deleteTemplate: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { PUT, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { deleteTemplate as deleteMetaTemplate } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { LOC_A, LOC_B, person, MASTER } from '../../../../../../tests/helpers/owner-at-location-callers.js'

const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }
const TEMPLATE = { id: 't1', name: 'promo_x', location_id: LOC_B, status: 'APPROVED', display_group: null }
const FORBIDDEN = { success: false, error: 'Forbidden' }
const NOT_FOUND = { success: false, error: 'Not found' }

// Reads answer TEMPLATE; update/delete are recorded as writes.
function makeDb() {
  const writes = []
  return {
    writes,
    from: (table) => {
      let op = 'read'
      let patch
      const b = {
        select: () => b,
        update: (p) => { op = 'update'; patch = p; return b },
        delete: () => { op = 'delete'; return b },
        eq: (col, val) => { if (op !== 'read') writes.push({ table, op, patch, where: [col, val] }); return b },
        single: async () => ({ data: op === 'update' ? { ...TEMPLATE, ...patch } : TEMPLATE, error: null }),
        then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
      }
      return b
    },
  }
}

const ctx = { params: Promise.resolve({ id: 't1' }) }
const del = () => DELETE(new Request('https://crm.test/api/whatsapp/templates/t1', { method: 'DELETE' }), ctx)
const put = (body) => PUT(new Request('https://crm.test/api/whatsapp/templates/t1', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), ctx)

const ALLOWED = [
  ['a manager there', person({ [LOC_B]: 'manager' }, LOC_B)],
  ['a head coach there', person({ [LOC_B]: 'head_coach' }, LOC_B)],
  ['an owner there', person({ [LOC_B]: 'owner' }, LOC_B)],
  ['staff at the active studio, manager at the template\'s', person({ [LOC_A]: 'staff', [LOC_B]: 'manager' }, LOC_A)],
  ['a master', MASTER],
]
const REFUSED = [
  ['staff there', person({ [LOC_B]: 'staff' }, LOC_B)],
  ['reception there', person({ [LOC_B]: 'reception' }, LOC_B)],
  ['a manager at the active studio who is staff at the template\'s', person({ [LOC_A]: 'manager', [LOC_B]: 'staff' }, LOC_A)],
]
const OUTSIDER = person({ [LOC_A]: 'owner' }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  deleteMetaTemplate.mockResolvedValue({ success: true })
})

describe('DELETE — MANAGER_ROLES at the template (WATPLROLE.1)', () => {
  it.each(ALLOWED)('%s: deleted at Meta and locally (200)', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await del()
    expect(res.status).toBe(200)
    expect(deleteMetaTemplate).toHaveBeenCalledTimes(1)
    expect(deleteMetaTemplate.mock.calls[0][0]).toBe('promo_x')
    expect(db.writes).toEqual([{ table: 'whatsapp_templates', op: 'delete', patch: undefined, where: ['id', 't1'] }])
  })

  it.each(REFUSED)('%s: refused (403); nothing deleted at Meta or locally', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await del()
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: FORBIDDEN })
    expect(deleteMetaTemplate).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('a caller who does not belong to the template\'s location: 404, as before', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const res = await del()
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 404, body: NOT_FOUND })
    expect(deleteMetaTemplate).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
})

describe('PUT — a field that drives a send needs MANAGER_ROLES at the template (WATPLROLE.1)', () => {
  const META_OWNED = [
    ['status', { status: 'APPROVED' }],
    ['components', { components: [{ type: 'BODY', text: 'Changed' }] }],
    ['header media url', { header_media_url: 'https://example.test/other.jpg' }],
    ['name', { name: 'promo_y' }],
    ['display_group together with another field', { display_group: 'Offers', category: 'UTILITY' }],
  ]

  it.each(META_OWNED)('staff there, %s: refused (403), nothing written', async (_label, body) => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'staff' }, LOC_B))
    const res = await put(body)
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: FORBIDDEN })
    expect(db.writes).toEqual([])
  })

  it.each(ALLOWED)('%s: a Meta-owned field is saved (200)', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await put({ status: 'APPROVED' })
    expect(res.status).toBe(200)
    expect(db.writes).toEqual([{ table: 'whatsapp_templates', op: 'update', patch: { status: 'APPROVED' }, where: ['id', 't1'] }])
  })

  it.each([...REFUSED, ...ALLOWED])('%s: a display_group-only edit is saved (200), the picker grouping stays open to members', async (_label, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await put({ display_group: '  Offers  ' })
    expect(res.status).toBe(200)
    expect(db.writes).toEqual([{ table: 'whatsapp_templates', op: 'update', patch: { display_group: 'Offers' }, where: ['id', 't1'] }])
  })

  it('a caller who does not belong to the template\'s location: 404 for either kind of edit, nothing written', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    for (const body of [{ display_group: 'Offers' }, { status: 'APPROVED' }]) {
      const res = await put(body)
      expect({ status: res.status, body: await res.json() }).toEqual({ status: 404, body: NOT_FOUND })
    }
    expect(db.writes).toEqual([])
  })
})
