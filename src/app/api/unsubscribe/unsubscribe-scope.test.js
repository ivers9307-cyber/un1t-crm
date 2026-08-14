import { describe, it, expect, vi, beforeEach } from 'vitest'

// LOCCOMMS.4 — unsubscribe must mean "stop mailing me from THIS business".
//
// Before this, one link removed someone from every UN1T list. With Stillorgan
// at 3,364 reachable contacts against Hatch Street's 82, a single Hatch
// campaign could strip members off the list of the gym they actually attend.

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// UNSUB-RL.1 — the route now peeks a per-IP invalid-token budget before the
// lookup and spends a per-TOKEN budget after it. Both allow here; the
// budgeting behaviour itself is pinned in unsubscribe-rate-limit.test.js.
vi.mock('@/lib/rate-limit', () => ({
  peekRateLimit: vi.fn(async () => ({ allowed: true })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/app-url', () => ({ getRequestOrigin: vi.fn(() => 'https://crm.example') }))

import { createServerClient } from '@/lib/supabase'
import { POST } from './[token]/route'

// UNSUB-RL.1 — ?l= is now shape-checked before it reaches .eq('location_id')
// and the location_id FK, so the fixture has to be a real UUID.
const HATCH = '22222222-3333-4444-8555-666666666666'

// Records every write so the test can assert WHICH table was touched — the
// distinction that matters, because writing contact_preferences would let the
// mig 489 trigger fan the opt-out out to every location.
//
// UNSUBAUTO.3 — the fake can now FAIL a write. `updateErrors` / `insertErrors`
// are keyed by table; a match makes that call resolve `{ error }` instead of
// `{ error: null }`. The update chain is a thenable that resolves to the
// result object (which is what a supabase-js builder is), so the route reads
// the error off `await …update().eq().eq()` exactly as it does in prod.
function makeDb({ pref, locRow, updateErrors = {}, insertErrors = {} }) {
  const writes = { contact_preferences: [], contact_location_preferences: [], contacts: [], consent_log: [] }
  // COMMSFIX.C.4 — the route now attributes an actual opt-out flip to the
  // campaign that carried the link, so the fake has to record rpc calls.
  const rpcCalls = []
  const db = {
    from(table) {
      const api = {
        select() { return api },
        eq() { return api },
        single: async () => ({ data: table === 'contact_preferences' ? pref : null, error: null }),
        maybeSingle: async () => ({
          data: table === 'contact_location_preferences' ? locRow : null, error: null,
        }),
        update(row) {
          writes[table]?.push(row)
          const result = { error: updateErrors[table] || null }
          const chain = {
            eq() { return chain },
            in() { return chain },
            then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
          }
          return chain
        },
        insert(rows) {
          writes[table]?.push(...[].concat(rows))
          return Promise.resolve({ error: insertErrors[table] || null })
        },
      }
      return api
    },
    rpc(fn, args) { rpcCalls.push([fn, args]); return Promise.resolve({ error: null }) },
  }
  return { db, writes, rpcCalls }
}

const req = (url, body) => new Request(url, {
  method: 'POST',
  body: body ? JSON.stringify(body) : undefined,
})

// UNSUB-RL.1 — the route now shape-checks the token before any lookup, so
// the fixture has to be a real UUID like the one mig 005 mints.
const TOK = '9f1c7c0e-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ token: TOK }) }

beforeEach(() => vi.clearAllMocks())

describe('LOCCOMMS.4 — per-location unsubscribe', () => {
  it('with ?l= writes ONLY the location row, never contact_preferences', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}`), props)

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

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}`), props)

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

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}`), props)

    expect(writes.contact_location_preferences).toHaveLength(1)
    expect(writes.contact_location_preferences[0]).toMatchObject({ email_marketing: false })
  })

  it('records the location on the consent_log row', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}`), props)

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

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}`), props)

    const patch = writes.contact_location_preferences[0]
    expect(patch.email_marketing).toBe(false)
    expect(patch.sms_marketing).toBeUndefined()
    expect(patch.whatsapp_marketing).toBeUndefined()
  })
})

// COMMSFIX.C.4 — attribute one-click / footer unsubscribes to the campaign.
//
// campaigns.total_unsubscribed only ever moved on Postmark's own
// SubscriptionChange webhook, which fires for POSTMARK-side suppressions (spam
// complaint, hard bounce, manual). Gmail/Apple one-click and the email footer
// both resolve HERE, so the counter an operator reads to spot a campaign that
// burned the list sat near zero no matter how many people left.
const CAMP = '11111111-2222-4333-8444-555555555555'

describe('COMMSFIX.C.4 — campaign attribution on unsubscribe', () => {
  it('increments total_unsubscribed for the campaign when the opt-out actually flipped', async () => {
    const { db, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}&c=${CAMP}`), props)

    expect(rpcCalls).toContainEqual([
      'increment_campaign_metric',
      { p_campaign_id: CAMP, p_field: 'total_unsubscribed' },
    ])
  })

  it('does NOT increment when nothing flipped — a replayed click must not inflate it', async () => {
    const { db, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: false, contacts: { id: 'c1' } },
      locRow: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}&c=${CAMP}`), props)

    expect(res.status).toBe(200)
    expect(rpcCalls).toEqual([])
  })

  it('only counts an EMAIL opt-out — an SMS-only opt-out is not an email unsubscribe', async () => {
    const { db, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: false, contacts: { id: 'c1' } },
      locRow: { email_marketing: false, sms_marketing: true, whatsapp_marketing: false },
    })
    createServerClient.mockReturnValue(db)

    await POST(
      req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}&c=${CAMP}`, { channels: ['sms_marketing'] }),
      props,
    )

    expect(rpcCalls).toEqual([])
  })

  it('ignores a garbage campaign id rather than firing an rpc that will raise', async () => {
    const { db, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}&c=not-a-uuid`), props)

    expect(rpcCalls).toEqual([])
  })

  it('with no c= at all, behaves exactly as before', async () => {
    const { db, writes, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}`), props)

    expect(rpcCalls).toEqual([])
    expect(writes.contact_location_preferences).toHaveLength(1)
  })
})

// UNSUBAUTO.3 — the route must not report a success it did not achieve.
//
// Both consent writes were `await`ed with the error DISCARDED, and the handler
// returned `{ success: true }` unconditionally. That was survivable while the
// page sat behind a confirm button; UNSUBAUTO.1 made the page auto-submit and
// key its "You've been unsubscribed" screen off `data.success`, so a failed
// write now renders that screen to somebody who is still fully subscribed —
// the exact harm this branch exists to remove.
//
// The asymmetry below is deliberate and is asserted, not assumed: the
// PREFERENCE write failing means the opt-out did not happen (500), while the
// consent_log insert failing means only the audit row is missing (200).
describe('UNSUBAUTO.3 — a failed consent write is never reported as success', () => {
  const errorSpy = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('returns 500 + success:false when the SCOPED preference write errors', async () => {
    const spy = errorSpy()
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
      updateErrors: { contact_location_preferences: { message: 'permission denied' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}`), props)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBe(false)
    // And nothing may claim the opt-out happened: no audit row for a write
    // that did not land.
    expect(writes.consent_log).toHaveLength(0)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns 500 + success:false when the GLOBAL preference write errors', async () => {
    const spy = errorSpy()
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: null,
      updateErrors: { contact_preferences: { message: 'permission denied' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOK}`), props)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBe(false)
    expect(writes.consent_log).toHaveLength(0)
    spy.mockRestore()
  })

  it('a failed preference write does NOT count a campaign unsubscribe', async () => {
    const spy = errorSpy()
    const { db, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
      updateErrors: { contact_location_preferences: { message: 'permission denied' } },
    })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}&c=${CAMP}`), props)

    expect(rpcCalls).toEqual([])
    spy.mockRestore()
  })

  it('still returns 200 + success:true when ONLY the consent_log insert errors', async () => {
    // The person genuinely IS unsubscribed here — the preference write landed.
    // Failing the request would make a mail provider retry an opt-out that has
    // already taken effect. The audit row is secondary; losing it is worth a
    // console.error, not a 500.
    const spy = errorSpy()
    const { db, writes, rpcCalls } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
      insertErrors: { consent_log: { message: 'consent_log unavailable' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOK}?l=${HATCH}&c=${CAMP}`), props)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(writes.contact_location_preferences).toHaveLength(1)
    // …and the rest of the request still runs: the campaign attribution is not
    // skipped just because the audit row failed.
    expect(rpcCalls).toContainEqual([
      'increment_campaign_metric',
      { p_campaign_id: CAMP, p_field: 'total_unsubscribed' },
    ])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
