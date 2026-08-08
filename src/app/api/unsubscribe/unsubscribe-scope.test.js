import { describe, it, expect, vi, beforeEach } from 'vitest'

// LOCCOMMS.4 — unsubscribe must mean "stop mailing me from THIS business".
//
// Before this, one link removed someone from every UN1T list. With Stillorgan
// at 3,364 reachable contacts against Hatch Street's 82, a single Hatch
// campaign could strip members off the list of the gym they actually attend.

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/app-url', () => ({ getRequestOrigin: vi.fn(() => 'https://crm.example') }))

import { createServerClient } from '@/lib/supabase'
import { POST } from './[token]/route'

const HATCH = 'loc-hatch'

// Records every write so the test can assert WHICH table was touched — the
// distinction that matters, because writing contact_preferences would let the
// mig 489 trigger fan the opt-out out to every location.
function makeDb({ pref, locRow }) {
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

const req = (url, body) => new Request(url, {
  method: 'POST',
  body: body ? JSON.stringify(body) : undefined,
})

const props = { params: Promise.resolve({ token: 'tok' }) }

beforeEach(() => vi.clearAllMocks())

describe('LOCCOMMS.4 — per-location unsubscribe', () => {
  it('with ?l= writes ONLY the location row, never contact_preferences', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/tok?l=${HATCH}`), props)

    expect(writes.contact_location_preferences).toHaveLength(1)
    expect(writes.contact_location_preferences[0]).toMatchObject({ email_marketing: false })
    // Writing the global row would trip the mig 489 trigger and unsubscribe
    // them from EVERY location — the precise harm this PR prevents.
    expect(writes.contact_preferences).toHaveLength(0)
    // And the global email_status flag must not be stamped on a scoped opt-out.
    expect(writes.contacts).toHaveLength(0)
  })

  it('with NO ?l= writes the global row — back-compat for links already in inboxes', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: null,
    })
    createServerClient.mockReturnValue(db)

    await POST(req('https://crm.example/api/unsubscribe/tok'), props)

    expect(writes.contact_preferences).toHaveLength(1)
    expect(writes.contact_location_preferences).toHaveLength(0)
    // LOCCOMMS.5 — the global email_status stamp is retired. email_status now
    // carries reputation only; the opt-out lives in contact_preferences (and
    // the mig 489 trigger fans it to every location row).
    expect(writes.contacts).toHaveLength(0)
  })

  it('scoped opt-out reads the LOCATION row, not the global one', async () => {
    // THE regression this test exists for. Someone opted out globally but opted
    // IN at one location — the exact shape of the leads recovered in LEADCAP.1.
    // Judging "is this channel on?" from the global row yields an empty patch,
    // so their click would silently do nothing.
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: false, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/tok?l=${HATCH}`), props)

    expect(writes.contact_location_preferences).toHaveLength(1)
    expect(writes.contact_location_preferences[0]).toMatchObject({ email_marketing: false })
  })

  it('records the location on the consent_log row', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/tok?l=${HATCH}`), props)

    expect(writes.consent_log[0]).toMatchObject({
      contact_id: 'c1', channel: 'email_marketing', action: 'opt_out', location_id: HATCH,
    })
  })

  it('an empty body still means email only — Gmail one-click must not take WhatsApp too', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/tok?l=${HATCH}`), props)

    const patch = writes.contact_location_preferences[0]
    expect(patch.email_marketing).toBe(false)
    expect(patch.sms_marketing).toBeUndefined()
    expect(patch.whatsapp_marketing).toBeUndefined()
  })
})
