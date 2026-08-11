// EMAILREP.2 — a staff preference edit must never clear a bounce.
//
// contacts.email_status is REPUTATION (mig 492/501: active | bounced |
// complained). It is a hard send-time gate: buildAudienceQuery applies
// .not('email_status','in','("bounced","complained")') UNCONDITIONALLY, to
// administrative mail as well as marketing. So clearing it puts a dead or
// complaining mailbox back into the sendable audience on every channel.
//
// This route stamped { email_status: 'active' } on ANY change to
// email_marketing — including an OPT-OUT — which silently un-suppressed
// bounced addresses. The rule now matches every other consent writer
// (emailStatusNormaliseForOptIn, shared with marketing-consent.js and the
// bulk-import route): an opt-out never touches reputation, and an opt-in
// only normalises legacy residue (NULL / retired 'unsubscribed') to
// 'active'. A staff toggle is not evidence the mailbox works.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
}))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { PATCH } from './route.js'

// Chainable recorder — records every write so a test can assert which
// table was touched and with what (same shape as preferences-route.test.js).
function makeDb({ contact, pref }) {
  const writes = { contacts: [], contact_preferences: [], consent_log: [] }
  const db = {
    from(table) {
      const api = {
        select() { return api },
        eq() { return api },
        maybeSingle: async () => ({
          data: table === 'contacts' ? contact : table === 'contact_preferences' ? pref : null,
          error: null,
        }),
        update(row) { writes[table]?.push(row); return api },
        upsert(row) { writes[table]?.push(row); return Promise.resolve({ error: null }) },
        insert(rows) { writes[table]?.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
      }
      return api
    },
  }
  return { db, writes }
}

const CONTACT_ID = 'c1'
const req = (body) => new Request(`https://crm.example/api/contacts/${CONTACT_ID}/marketing-preferences`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const props = { params: Promise.resolve({ id: CONTACT_ID }) }

// The preferences row currently says opted-IN, so { email_marketing: false }
// is a real change and { email_marketing: true } is a no-op — each test
// picks the starting point it needs.
const prefIn = { id: 'p1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true }
const prefOut = { id: 'p1', email_marketing: false, sms_marketing: false, whatsapp_marketing: false }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', role: 'owner', isMaster: false })
})

async function run({ emailStatus, body, pref }) {
  const { db, writes } = makeDb({
    contact: { location_id: 'loc-1', email_status: emailStatus },
    pref,
  })
  createServerClient.mockReturnValue(db)
  const res = await PATCH(req(body), props)
  return { res, writes }
}

describe('PATCH /api/contacts/[id]/marketing-preferences — reputation guard (EMAILREP.2)', () => {
  it('a marketing OPT-OUT never touches contacts.email_status', async () => {
    const { res, writes } = await run({
      emailStatus: 'bounced', body: { email_marketing: false }, pref: prefIn,
    })
    expect((await res.json()).success).toBe(true)
    // The opt-out itself is recorded…
    expect(writes.contact_preferences).toHaveLength(1)
    expect(writes.contact_preferences[0]).toMatchObject({ email_marketing: false })
    // …and the bounce survives it.
    expect(writes.contacts).toHaveLength(0)
  })

  it('an opt-out on a healthy contact writes nothing to contacts either', async () => {
    const { writes } = await run({
      emailStatus: 'active', body: { email_marketing: false }, pref: prefIn,
    })
    expect(writes.contacts).toHaveLength(0)
  })

  it('an OPT-IN does NOT clear a bounced reputation', async () => {
    const { writes } = await run({
      emailStatus: 'bounced', body: { email_marketing: true }, pref: prefOut,
    })
    expect(writes.contact_preferences).toHaveLength(1)
    expect(writes.contacts).toHaveLength(0)
  })

  it('an OPT-IN does NOT clear a complained reputation', async () => {
    const { writes } = await run({
      emailStatus: 'complained', body: { email_marketing: true }, pref: prefOut,
    })
    expect(writes.contacts).toHaveLength(0)
  })

  it('an OPT-IN still normalises a legacy NULL to active', async () => {
    const { writes } = await run({
      emailStatus: null, body: { email_marketing: true }, pref: prefOut,
    })
    expect(writes.contacts).toEqual([{ email_status: 'active' }])
  })

  it("an OPT-IN still normalises retired 'unsubscribed' residue to active", async () => {
    const { writes } = await run({
      emailStatus: 'unsubscribed', body: { email_marketing: true }, pref: prefOut,
    })
    expect(writes.contacts).toEqual([{ email_status: 'active' }])
  })

  it('an OPT-IN on an already-active contact writes nothing (no pointless PATCH)', async () => {
    const { writes } = await run({
      emailStatus: 'active', body: { email_marketing: true }, pref: prefOut,
    })
    expect(writes.contacts).toHaveLength(0)
  })

  it('a non-email channel change never touches contacts', async () => {
    const { writes } = await run({
      emailStatus: 'bounced', body: { sms_marketing: false }, pref: prefIn,
    })
    expect(writes.contact_preferences).toHaveLength(1)
    expect(writes.contacts).toHaveLength(0)
  })
})
