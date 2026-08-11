import { describe, it, expect, vi, beforeEach } from 'vitest'

// COMMSFIX.A.3 — preferences PUT must not fire db.from('contacts').update(null).
//
// LOCCOMMS.5 made email_status reputation-only, so a marketing OPT-OUT has
// nothing to write to contacts — but the false branch left contactUpdate
// null and still ran the update, a guaranteed-failing PATCH on every single
// opt-out. Opt-IN (re-consent) still writes { email_status: 'active',
// email_suppressed_at: null } (EMAIL-HYGIENE.1).

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// UNSUB-RL.1 — the route now peeks a per-IP invalid-token budget before the
// lookup and spends a per-TOKEN budget after it. Both allow here.
vi.mock('@/lib/rate-limit', () => ({
  peekRateLimit: vi.fn(async () => ({ allowed: true })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))

import { createServerClient } from '@/lib/supabase'
import { PUT } from './[token]/route'

// Same chainable recorder as unsubscribe-scope.test.js — records every
// write so the test can assert which table was touched and with what.
function makeDb({ pref, locRow = null }) {
  const writes = { contact_preferences: [], contact_location_preferences: [], contacts: [], consent_log: [] }
  const db = {
    from(table) {
      const api = {
        select() { return api },
        eq() { return api },
        single: async () => ({ data: table === 'contact_preferences' ? pref : null, error: null }),
        maybeSingle: async () => ({
          data: table === 'contact_location_preferences' ? locRow : null, error: null,
        }),
        update(row) { writes[table]?.push(row); return api },
        insert(rows) { writes[table]?.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
      }
      return api
    },
  }
  return { db, writes }
}

// UNSUB-RL.1 — the route shape-checks the token before any lookup, so the
// fixture has to be a real UUID like the one mig 005 mints.
const TOK = '9f1c7c0e-0000-4000-8000-000000000001'

const req = (body) => new Request(`https://crm.example/api/preferences/${TOK}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const props = { params: Promise.resolve({ token: TOK }) }

beforeEach(() => vi.clearAllMocks())

describe('COMMSFIX.A.3 — preferences PUT null-update guard', () => {
  it('a marketing opt-out performs NO contacts update (nothing to write)', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ email_marketing: false }), props)
    const json = await res.json()

    expect(json.success).toBe(true)
    // The opt-out itself is recorded on contact_preferences…
    expect(writes.contact_preferences).toHaveLength(1)
    expect(writes.contact_preferences[0]).toMatchObject({ email_marketing: false })
    // …but contacts must not be touched: update(null) is a failed PATCH.
    expect(writes.contacts).toHaveLength(0)
  })

  it('re-consent still stamps email_status active and clears the suppression', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: false, contacts: { id: 'c1' } },
    })
    createServerClient.mockReturnValue(db)

    await PUT(req({ email_marketing: true }), props)

    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0]).toEqual({ email_status: 'active', email_suppressed_at: null })
  })
})
