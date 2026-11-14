// STAFFCONSENT.1 — staff switch one studio's marketing email, with a reason.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => ({
  ...(await vi.importActual('@/lib/role-at-location')),
  getCurrentUser: vi.fn(),
}))
vi.mock('@/lib/consent-propagation', () => ({ propagateOptOut: vi.fn(async () => {}) }))
vi.mock('@/lib/postmark-suppressions', () => ({
  suppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [] })),
  unsuppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [], skipped: [] })),
}))
vi.mock('@/lib/postmark-server-for-location', () => ({ serverTokenForLocation: vi.fn(async () => null) }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { POST } from './route.js'

const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const CID = 'c0000000-0000-0000-0000-000000000001'

function makeDb({ contact, rel = null, locRow }) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const call = { table, op: 'select', payload: null, filters: [] }
      calls.push(call)
      const b = {
        select() { return b },
        update(p) { call.op = 'update'; call.payload = p; return b },
        insert(p) { call.op = 'insert'; call.payload = p; return Promise.resolve({ error: null }) },
        eq(c, v) { call.filters.push([c, v]); return b },
        limit() { return b },
        maybeSingle: async () => ({
          data: table === 'contacts' ? contact : table === 'contact_studios' ? rel : table === 'contact_location_preferences' ? locRow : null,
          error: null,
        }),
        then(res, rej) { return Promise.resolve({ data: null, error: null }).then(res, rej) },
      }
      return b
    },
  }
  return db
}

const req = (body) => new Request(`https://crm.example/api/contacts/${CID}/studio-consent`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const props = { params: Promise.resolve({ id: CID }) }
const contactAt = (loc) => ({ id: CID, email: 'a@x.com', wa_phone: null, email_status: 'active', location_id: loc })
const ownerAtStill = { id: 'u1', isMaster: false, rolesByLocation: { [STILL]: 'owner' } }

async function run({ user = ownerAtStill, body, contact = contactAt(STILL), rel, locRow = { email_marketing: false } }) {
  getCurrentUser.mockResolvedValue(user)
  const db = makeDb({ contact, rel, locRow })
  createServerClient.mockReturnValue(db)
  const res = await POST(req(body), props)
  return { res, json: await res.json(), db }
}

const writes = (db) => db.calls.filter((c) => c.op === 'update' || c.op === 'insert')
const valid = { location_id: STILL, email_marketing: true, reason: 'email' }

beforeEach(() => { vi.clearAllMocks() })

describe('POST /api/contacts/[id]/studio-consent', () => {
  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req(valid), props)
    expect(res.status).toBe(401)
  })

  it('switches the studio on and logs who, why and the note', async () => {
    const { res, json, db } = await run({ body: { ...valid, note: 'asked at the desk' } })
    expect(res.status).toBe(200)
    expect(json).toEqual({ success: true, data: { changed: ['email_marketing'] } })
    const log = db.calls.find((c) => c.table === 'consent_log')
    expect(log.payload[0]).toMatchObject({ source: 'staff_studio', performed_by: 'u1', reason: 'email', note: 'asked at the desk', location_id: STILL })
  })

  it('an opt-out at one studio never writes the overall contact_preferences row', async () => {
    const { db } = await run({ body: { ...valid, email_marketing: false }, locRow: { email_marketing: true } })
    expect(db.calls.some((c) => c.table === 'contact_preferences')).toBe(false)
    const write = db.calls.find((c) => c.table === 'contact_location_preferences' && c.op === 'update')
    expect(write.payload.email_marketing).toBe(false)
  })

  it('a Hatch manager cannot change a Stillorgan setting (not found, nothing written)', async () => {
    const { res, db } = await run({ user: { id: 'u2', isMaster: false, rolesByLocation: { [HATCH]: 'manager' } }, body: valid })
    expect(res.status).toBe(404)
    expect(writes(db)).toEqual([])
  })

  it('plain staff at the studio are refused as not found', async () => {
    const { res } = await run({ user: { id: 'u3', isMaster: false, rolesByLocation: { [STILL]: 'staff' } }, body: valid })
    expect(res.status).toBe(404)
  })

  it('a contact with no relationship to that studio is not found', async () => {
    const { res, db } = await run({ contact: contactAt(HATCH), rel: null, body: valid })
    expect(res.status).toBe(404)
    expect(writes(db)).toEqual([])
  })

  it('a contact homed elsewhere but holding a contact_studios row there can be changed', async () => {
    const { res } = await run({ contact: contactAt(HATCH), rel: { contact_id: CID }, body: valid })
    expect(res.status).toBe(200)
  })

  it('an unknown contact is not found', async () => {
    const { res } = await run({ contact: null, body: valid })
    expect(res.status).toBe(404)
  })

  it.each([
    ['other with no note', { ...valid, reason: 'other' }],
    ['other with a whitespace note', { ...valid, reason: 'other', note: '   ' }],
    ['a reason off the list', { ...valid, reason: 'because' }],
    ['no reason', { location_id: STILL, email_marketing: true }],
    ['a note over 500 characters', { ...valid, note: 'x'.repeat(501) }],
  ])('refuses %s, writing nothing', async (_label, body) => {
    const { res, db } = await run({ body })
    expect(res.status).toBe(400)
    expect(writes(db)).toEqual([])
  })

  it('accepts other with a note', async () => {
    const { res } = await run({ body: { ...valid, reason: 'other', note: 'came in with a friend' } })
    expect(res.status).toBe(200)
  })

  it('a second press is a no-op with no extra log row', async () => {
    const { json, db } = await run({ body: valid, locRow: { email_marketing: true } })
    expect(json).toEqual({ success: true, data: { changed: [] } })
    expect(writes(db)).toEqual([])
  })

  it('no studio row for the contact there is not found', async () => {
    const { res } = await run({ body: valid, locRow: null })
    expect(res.status).toBe(404)
  })

  it('a master may act at any studio', async () => {
    const { res } = await run({ user: { id: 'm', isMaster: true, profileRole: 'master', rolesByLocation: {} }, body: valid })
    expect(res.status).toBe(200)
  })
})
