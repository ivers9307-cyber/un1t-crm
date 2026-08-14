import { describe, it, expect, vi, beforeEach } from 'vitest'

// COMMSFIX.A.3 — preferences PUT must not fire db.from('contacts').update(null).
//
// LOCCOMMS.5 made email_status reputation-only, so a marketing OPT-OUT has
// nothing to write to contacts — but the false branch left contactUpdate
// null and still ran the update, a guaranteed-failing PATCH on every single
// opt-out.
//
// EMAILREP.4 — an opt-IN no longer stamps email_status: 'active' flat. It goes
// through emailStatusNormaliseForOptIn, so NULL / legacy 'unsubscribed' residue
// normalises but `bounced` / `complained` SURVIVE a re-consent (reputation is
// address-bound and gates administrative mail too).
//
// NOENGSUP.1 — an opt-in no longer touches `email_suppressed_at` either. It
// used to clear unconditionally, which was right while that column was our own
// 90-day-non-opener heuristic. mig 537 retired that rule, so the only stamps
// left are REPEAT-BOUNCE suppressions, and clearing one on a customer click
// would un-suppress a bouncing address AND auto-close its escalation row
// (bounce-escalation-sweep reads a cleared stamp as 'stamp_cleared_externally').
// So an opt-in now writes ONLY a normalised reputation, if there is one — which
// means the patch can legitimately be empty and no PATCH is sent at all.

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
//
// UNSUBAUTO.3 — and, like that one, it can now FAIL a write: `updateErrors` /
// `insertErrors` are keyed by table and make that call resolve `{ error }`.
// The update chain is a thenable resolving to the result object, the shape a
// supabase-js builder has, so the route reads the error the same way it does
// against a real client.
function makeDb({ pref, locRow = null, updateErrors = {}, insertErrors = {} }) {
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

})

// EMAILREP.4 — the preference centre was the one marketing-opt-in writer that
// never adopted emailStatusNormaliseForOptIn, so a re-consent click un-gated a
// hard-bounced or complaining mailbox for EVERY send path, administrative mail
// included.
describe('EMAILREP.4 — re-consent may normalise reputation, never restore it', () => {
  // The route reads the CURRENT status off the contacts embed. Passing
  // `undefined` (the shape before the embed was widened to select
  // email_status) makes the helper return null for every row — which reads as
  // "the guard works" while silently never normalising legacy NULL rows
  // either. The null/'unsubscribed' cases below are what catch that.
  const optInWith = async (email_status) => {
    const { db, writes } = makeDb({
      pref: {
        id: 'p1', contact_id: 'c1', email_marketing: false,
        contacts: { id: 'c1', email_status },
      },
    })
    createServerClient.mockReturnValue(db)
    await PUT(req({ email_marketing: true }), props)
    return writes
  }

  it('normalises a legacy NULL status to active', async () => {
    const writes = await optInWith(null)
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0]).toEqual({ email_status: 'active' })
  })

  it("normalises retired 'unsubscribed' residue to active", async () => {
    const writes = await optInWith('unsubscribed')
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0]).toEqual({ email_status: 'active' })
  })

  it('leaves a bounced address bounced — consent is not evidence the mailbox works', async () => {
    const writes = await optInWith('bounced')
    expect(writes.contacts).toHaveLength(0)
  })

  it('leaves a complained address complained', async () => {
    const writes = await optInWith('complained')
    expect(writes.contacts).toHaveLength(0)
  })

  it("writes nothing at all for an already-'active' row", async () => {
    const writes = await optInWith('active')
    expect(writes.contacts).toHaveLength(0)
  })

  it('NOENGSUP.1 — never clears a repeat-bounce suppression on a customer click', async () => {
    // The load-bearing one. Whatever else an opt-in does, email_suppressed_at
    // must not appear in the patch: a click would otherwise erase both the
    // suppression and the escalation row that justifies it.
    for (const status of [null, 'unsubscribed', 'active', 'bounced', 'complained']) {
      const writes = await optInWith(status)
      for (const patch of writes.contacts) {
        expect(patch).not.toHaveProperty('email_suppressed_at')
      }
    }
  })

  it('opt-out still performs no contacts write at all', async () => {
    const { db, writes } = makeDb({
      pref: {
        id: 'p1', contact_id: 'c1', email_marketing: true,
        contacts: { id: 'c1', email_status: 'bounced' },
      },
    })
    createServerClient.mockReturnValue(db)

    await PUT(req({ email_marketing: false }), props)

    expect(writes.contacts).toHaveLength(0)
  })
})

// UNSUBAUTO.3 — same defect, same fix, as /api/unsubscribe/[token]: the
// preference write was `await`ed with its error discarded and the handler
// returned `{ success: true }` regardless. UnsubscribePage's Resubscribe
// button and PreferenceCentre both key their confirmation off that flag, so a
// failed write told the person the opposite of what the database holds.
//
// The asymmetry is deliberate: the PREFERENCE write failing means the change
// did not happen (500); the consent_log insert failing loses only the audit
// row (200, logged).
const LOC = '22222222-3333-4444-8555-666666666666'

describe('UNSUBAUTO.3 — a failed consent write is never reported as success', () => {
  const errorSpy = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('returns 500 + success:false when the GLOBAL preference write errors', async () => {
    const spy = errorSpy()
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      updateErrors: { contact_preferences: { message: 'permission denied' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ email_marketing: false }), props)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBe(false)
    expect(writes.consent_log).toHaveLength(0)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns 500 + success:false when the SCOPED location write errors', async () => {
    const spy = errorSpy()
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
      updateErrors: { contact_location_preferences: { message: 'permission denied' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ locationId: LOC, email_marketing: false }), props)
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.success).toBe(false)
    expect(writes.consent_log).toHaveLength(0)
    spy.mockRestore()
  })

  it('still returns 200 + success:true when ONLY the consent_log insert errors', async () => {
    // The change landed. Failing the request here would tell somebody their
    // opt-out did not take when it did.
    const spy = errorSpy()
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1' } },
      insertErrors: { consent_log: { message: 'consent_log unavailable' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ email_marketing: false }), props)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(writes.contact_preferences).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
