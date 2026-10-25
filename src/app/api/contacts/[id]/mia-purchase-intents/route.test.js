// MIAHATCH.6 — GET /api/contacts/[id]/mia-purchase-intents.
//
// The read behind the "Payment link sent" chip on the contact page. The route
// uses the service-role client, so these tests pin what filters it:
//   - a contact the viewer cannot see is a 404 (never a 403)
//   - only the allowlisted columns are ever selected, and the response never
//     carries the checkout URL, the success-token hash, the entitlement
//     snapshot or the outcome, even if the db hands them back
//   - only intents at studios where the viewer holds Contacts come back

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/contact-crossovers', () => ({
  canViewContact: vi.fn(),
  contactStudioIds: vi.fn(),
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { canViewContact, contactStudioIds } from '@/lib/contact-crossovers'

const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'
const OTHER_STUDIO = 'a0000000-0000-4000-8000-000000000009'
const USER = { id: 'u1', locations: [{ id: HATCH }] }

const INTENT = {
  id: 'f0000000-0000-4000-8000-000000000001',
  location_id: HATCH,
  product_title: '10 class pack',
  status: 'link_sent',
  created_at: '2026-10-19T10:00:00.000Z',
  expires_at: '2026-10-19T22:00:00.000Z',
}

// A fake db that records the filters of each query and honours .in('location_id').
function makeDb({ contact = { id: CONTACT_ID, location_id: HATCH }, intents = [INTENT], contactErr = null, intentErr = null } = {}) {
  const calls = { selects: [], filters: [], tables: [] }
  return {
    calls,
    from(table) {
      calls.tables.push(table)
      const f = {}
      const b = {
        select: (cols) => { calls.selects.push({ table, cols }); return b },
        eq: (c, v) => { f[c] = v; return b },
        in: (c, v) => { f[c] = v; return b },
        order: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve({ data: contact, error: contactErr }),
        then(resolve, reject) {
          calls.filters.push({ table, ...f })
          const rows = (intents || []).filter((r) => !f.location_id || f.location_id.includes(r.location_id))
          return Promise.resolve({ data: intentErr ? null : rows, error: intentErr }).then(resolve, reject)
        },
      }
      return b
    },
  }
}

const call = () => GET(new Request('http://x/api/contacts/c/mia-purchase-intents'), { params: Promise.resolve({ id: CONTACT_ID }) })

beforeEach(() => {
  vi.resetAllMocks()
  getCurrentUser.mockResolvedValue(USER)
  canViewContact.mockResolvedValue(true)
  contactStudioIds.mockImplementation((_u, ids) => ids)
})

describe('GET /api/contacts/[id]/mia-purchase-intents', () => {
  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb())
    expect((await call()).status).toBe(401)
  })

  it('404 for a foreign contact (never 403) and reads no intents', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    canViewContact.mockResolvedValue(false)
    const res = await call()
    expect(res.status).toBe(404)
    expect(db.calls.tables).not.toContain('mia_purchase_intents')
  })

  it('404 when the contact does not exist', async () => {
    createServerClient.mockReturnValue(makeDb({ contact: null }))
    expect((await call()).status).toBe(404)
  })

  it('returns the live intent with only the allowlisted columns', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true, data: [INTENT] })
    const sel = db.calls.selects.find((s) => s.table === 'mia_purchase_intents')
    expect(sel.cols.split(',').map((c) => c.trim()).sort()).toEqual(
      ['created_at', 'expires_at', 'id', 'location_id', 'product_title', 'status'],
    )
  })

  it('never returns checkout_url or success_token_hash, even if the db hands them back', async () => {
    createServerClient.mockReturnValue(makeDb({
      intents: [{
        ...INTENT,
        checkout_url: 'https://pay.example.test/checkout/abc',
        success_token_hash: 'deadbeef',
        entitlement_snapshot: { credit_balance: 3 },
        outcome: { booked: true },
      }],
    }))
    const text = await (await call()).text()
    for (const leak of ['checkout_url', 'success_token_hash', 'entitlement_snapshot', 'outcome', 'pay.example.test', 'deadbeef']) {
      expect(text).not.toContain(leak)
    }
    expect(JSON.parse(text).data).toEqual([INTENT])
  })

  it("only the viewer's studios: filters by contact and the Contacts location set", async () => {
    const db = makeDb({ intents: [INTENT, { ...INTENT, id: 'f0000000-0000-4000-8000-000000000002', location_id: OTHER_STUDIO }] })
    createServerClient.mockReturnValue(db)
    const body = await (await call()).json()
    expect(body.data.map((r) => r.location_id)).toEqual([HATCH])
    const q = db.calls.filters.find((f) => f.table === 'mia_purchase_intents')
    expect(q.contact_id).toBe(CONTACT_ID)
    expect(q.location_id).toEqual([HATCH])
  })

  it('a viewer who holds Contacts at no studio gets an empty list and no intent query', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    contactStudioIds.mockReturnValue([])
    const body = await (await call()).json()
    expect(body).toEqual({ success: true, data: [] })
    expect(db.calls.tables).not.toContain('mia_purchase_intents')
  })

  it('500 when the intent read fails, without leaking the db message', async () => {
    createServerClient.mockReturnValue(makeDb({ intentErr: { message: 'relation boom' } }))
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom')
  })
})
