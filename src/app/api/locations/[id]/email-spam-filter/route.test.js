// MAIL-SPAM.1 — GET/PUT /api/locations/[id]/email-spam-filter, the
// per-location spam threshold (company_settings.email_spam_*, mig 584).
//
// Same shape, same gate and same fixtures as send-quiet-hours: the role is
// judged AT THE TARGET (params.id) via assertLocationAccess then
// guardMasterOrOwner — never `user.role`, which resolves at the caller's
// ACTIVE location. The audit cast is a MANAGER whose active studio is A and
// who is plain staff at B: their `user.role` says manager, and they must
// still be refused at B with NO write.
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so the real guards' contracts are what run here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { DEFAULT_EMAIL_SPAM_THRESHOLD } from '@/lib/email-spam'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const OWNER_A = {
  id: 'u1', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — manager at their ACTIVE studio A, plain staff at the
// target B. `user.role` is 'manager' (resolved at A); the target-role gate
// must refuse them at B.
const MANAGER_A_STAFF_B = {
  id: 'u2', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
const STAFF_A_OWNER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'owner' },
  activeLocation: { id: LOC_A },
}
const MANAGER_A = {
  id: 'u4', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
const OWNER_A_ONLY = { ...OWNER_A }
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

const COLS = ['email_spam_filter_enabled', 'email_spam_threshold']

function makeDb({ rows = [] } = {}) {
  const upserts = []
  return {
    upserts,
    from(table) {
      if (table !== 'company_settings') throw new Error(`unexpected db.from('${table}') in email-spam-filter test`)
      return {
        upsert(payload, opts) {
          upserts.push({ payload, opts })
          const echoed = Object.fromEntries(COLS.map((c) => [c, payload[c]]))
          return {
            select: () => ({ single: () => Promise.resolve({ data: echoed, error: null }) }),
          }
        },
        select() {
          return {
            eq: (col, val) => {
              if (col !== 'location_id') throw new Error(`unexpected .eq('${col}') in email-spam-filter GET`)
              return { limit: () => Promise.resolve({ data: rows.filter((r) => r.location_id === val), error: null }) }
            },
          }
        },
      }
    },
  }
}

const props = (id) => ({ params: { id } })
const put = (id, body) => new Request(`http://localhost/api/locations/${id}/email-spam-filter`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/email-spam-filter`)

const VALID = { enabled: true, threshold: 7.5 }

const SUCCESS_BODY = {
  success: true,
  data: {
    enabled: true,
    threshold: 7.5,
    default_threshold: DEFAULT_EMAIL_SPAM_THRESHOLD,
    can_edit: true,
  },
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('PUT — the legitimate flow', () => {
  it('an owner saving their own studio gets the success body', async () => {
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
  })

  it('writes ONLY the two spam columns plus the audit stamp, keyed on location_id', async () => {
    await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(db.upserts).toHaveLength(1)
    const { payload, opts } = db.upserts[0]
    expect(payload).toEqual({
      location_id: LOC_A,
      email_spam_filter_enabled: true,
      email_spam_threshold: 7.5,
      updated_at: expect.any(String),
      updated_by: 'u1',
    })
    expect(opts).toEqual({ onConflict: 'location_id' })
  })

  it('switching the filter off is stored and echoed as disabled', async () => {
    const res = await PUT(put(LOC_A, { enabled: false, threshold: 5 }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.upserts[0].payload.email_spam_filter_enabled).toBe(false)
    expect((await res.json()).data.enabled).toBe(false)
  })

  it('400s an out-of-range or non-numeric threshold without writing', async () => {
    expect((await PUT(put(LOC_A, { enabled: true, threshold: 25 }), props(LOC_A))).status).toBe(400)
    expect((await PUT(put(LOC_A, { enabled: true, threshold: -1 }), props(LOC_A))).status).toBe(400)
    expect((await PUT(put(LOC_A, { enabled: true, threshold: '5' }), props(LOC_A))).status).toBe(400)
    expect((await PUT(put(LOC_A, { enabled: true }), props(LOC_A))).status).toBe(400)
    expect(db.upserts).toEqual([])
  })
})

describe('PUT — the gate is the role AT THE TARGET studio', () => {
  it('🔴 refuses a caller whose ACTIVE role is manager but who is staff at the target, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await PUT(put(LOC_B, { enabled: false, threshold: 1 }), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit the spam filter.')
    expect(db.upserts).toEqual([])
  })

  it('refuses a manager at their own studio (owner or master only)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(403)
    expect(db.upserts).toEqual([])
  })

  it('refuses an owner of a DIFFERENT studio as "not one of your locations" — no write, no role hint', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_ONLY)
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).not.toMatch(/owners and masters/)
    expect(db.upserts).toEqual([])
  })

  it('lets an owner AT THE TARGET through even with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.upserts[0].payload.location_id).toBe(LOC_B)
  })

  it('lets a master through anywhere', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await PUT(put(LOC_B, VALID), props(LOC_B))).status).toBe(200)
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(put(LOC_A, VALID), props(LOC_A))).status).toBe(401)
    expect(db.upserts).toEqual([])
  })
})

describe('GET', () => {
  it('synthesises the defaults (enabled, 5.0) when the studio has no company_settings row', async () => {
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { enabled: true, threshold: 5, default_threshold: 5, can_edit: true },
    })
  })

  it('reads the saved row', async () => {
    db = makeDb({ rows: [{ location_id: LOC_A, email_spam_filter_enabled: false, email_spam_threshold: '9.5' }] })
    createServerClient.mockReturnValue(db)
    const res = await GET(get(LOC_A), props(LOC_A))
    expect((await res.json()).data).toMatchObject({ enabled: false, threshold: 9.5 })
  })

  it('can_edit follows the TARGET role: false for manager-at-A/staff-at-B reading B', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await GET(get(LOC_B), props(LOC_B))
    expect(res.status).toBe(200)
    expect((await res.json()).data.can_edit).toBe(false)
  })

  it('403s a location the caller is not assigned to', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_ONLY)
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(403)
  })
})
