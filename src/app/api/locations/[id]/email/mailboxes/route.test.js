// EMAIL-MAILBOX-ADMIN.1 — the studio's email accounts: who may list them and
// who may add one.
//
// THE PROPERTY THIS FILE EXISTS FOR
// A MANAGER MUST NOT REACH THIS SURFACE. A manager holds `email_inbox` and can
// already read the inbox, so the tempting gate is that same key — and it is
// wrong: a manager is not elevated, so a manager who could add a mailbox or
// edit grants could hand themselves `accounts@` and read the studio's billing
// correspondence. Every refusal test therefore asserts NO WRITE HAPPENED, not
// merely that the status code was 403: a route that 403s after writing is
// still a breach, and the status code alone cannot tell the two apart.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// MAILBOX-UNREACHABLE.1 — GET now resolves each address's MX. Mocked so no
// test in this file touches the network: the fixtures use REAL domains
// (un1tdublin.com, hatchstreetfitness.com) and a unit suite that quietly
// depends on live DNS goes red the day a resolver hiccups in CI.
vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { resolveMx } from 'node:dns/promises'
import { GET, POST } from './route'
import { _resetMxCache } from '@/lib/mail/mailbox-reachability'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, insertsInto, updatesTo, writesTo } from '@/app/api/email/tickets/_test-db'
import {
  LOC_A, LOC_B, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, MASTER, COACH_A, adminState,
} from './_test-fixtures'

const props = { params: { id: LOC_A } }

const getReq = () => new Request(`http://x/api/locations/${LOC_A}/email/mailboxes`)
const postReq = (body) => new Request(`http://x/api/locations/${LOC_A}/email/mailboxes`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let db
function setupDb(state) {
  db = makeDb(state)
  createServerClient.mockImplementation(() => db)
  return db
}

async function post(body, p = props) {
  const res = await POST(postReq(body), p)
  return { res, body: await res.json() }
}
async function list(p = props) {
  const res = await GET(getReq(), p)
  return { res, body: await res.json() }
}

// Google's MX, as un1tdublin.com really publishes it (checked 2026-08-26) —
// so the fixture studio is, correctly, an address that cannot receive here.
const GOOGLE_MX = [{ priority: 10, exchange: 'aspmx.l.google.com' }]
const POSTMARK_MX = [{ priority: 10, exchange: 'inbound.postmarkapp.com' }]

beforeEach(() => {
  vi.clearAllMocks()
  _resetMxCache()
  resolveMx.mockResolvedValue(POSTMARK_MX)
  getCurrentUser.mockResolvedValue(OWNER_A)
  setupDb(adminState())
})

describe('mailbox admin — the gate', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await list()).res.status).toBe(401)
    expect((await post({ address: 'sales@un1t.ie', label: 'Sales' })).res.status).toBe(401)
    expect(writesTo(db)).toEqual([])
  })

  it('REFUSES a manager at this location — and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)

    const listed = await list()
    expect(listed.res.status).toBe(403)

    const created = await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    expect(created.res.status).toBe(403)
    expect(created.body.error).toMatch(/owner of this studio/i)

    // The assertion that matters: not one row moved.
    expect(writesTo(db)).toEqual([])
    expect(db._state.mailboxes).toHaveLength(3)
  })

  it('refuses a head coach and a plain staffer too', async () => {
    for (const user of [COACH_A, { ...MANAGER_A, role: 'head_coach', profileRole: 'head_coach', rolesByLocation: { [LOC_A]: 'head_coach' } }]) {
      getCurrentUser.mockResolvedValue(user)
      expect((await post({ address: 'sales@un1t.ie', label: 'Sales' })).res.status).toBe(403)
    }
    expect(writesTo(db)).toEqual([])
  })

  it('refuses an OWNER OF A DIFFERENT STUDIO — "owner" is not a global role', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const { res, body } = await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    expect(res.status).toBe(403)
    // Location first: they are told it is not their studio, not handed a role
    // complaint that would confirm the location and imply they nearly qualified.
    expect(body.error).toMatch(/not in your assignments/i)
    expect(writesTo(db)).toEqual([])
  })

  it('ALLOWS the owner at this location', async () => {
    const { res } = await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    expect(res.status).toBe(201)
    expect(insertsInto(db, 'email_mailboxes')).toHaveLength(1)
  })

  it('ALLOWS master, who holds no per-location role at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await list()).res.status).toBe(200)
    expect((await post({ address: 'sales@un1tdublin.com', label: 'Sales' })).res.status).toBe(201)
  })
})

describe('GET — the management view', () => {
  it('lists deactivated accounts too (the inbox hides them; managing them is the point)', async () => {
    setupDb(adminState({ mailboxes: [{ ...MB_STUDIO }, { ...MB_ACCOUNTS, active: false }] }))
    const { body } = await list()
    expect(body.data.mailboxes.map(m => m.id)).toEqual([MB_STUDIO.id, MB_ACCOUNTS.id])
    expect(body.data.mailboxes[1].active).toBe(false)
  })

  it('never lists another studio’s accounts', async () => {
    const { body } = await list()
    expect(body.data.mailboxes.map(m => m.id)).not.toContain(MB_OTHER_LOCATION.id)
    expect(body.data.mailboxes.every(m => m.location_id === LOC_A)).toBe(true)
  })

  it('shows the owner as IMPLICIT and the manager as none, with no grant rows in the DB', async () => {
    const { body } = await list()
    const studio = body.data.mailboxes.find(m => m.id === MB_STUDIO.id)
    const byId = Object.fromEntries(studio.access.map(a => [a.profile_id, a]))
    expect(byId[OWNER_A.id].access).toBe('implicit')
    expect(byId[MANAGER_A.id].access).toBe('none')
    expect(byId[COACH_A.id].access).toBe('none')
    expect(db._state.grants).toEqual([])
  })

  it('reflects a real grant per mailbox, not per person', async () => {
    setupDb(adminState({
      grants: [{ mailbox_id: MB_STUDIO.id, profile_id: COACH_A.id, granted_by: OWNER_A.id, granted_at: '2026-08-07T09:00:00Z' }],
    }))
    const { body } = await list()
    const access = (id) => body.data.mailboxes.find(m => m.id === id).access.find(a => a.profile_id === COACH_A.id)
    expect(access(MB_STUDIO.id).access).toBe('granted')
    expect(access(MB_STUDIO.id).granted_by).toBe(OWNER_A.id)
    // studio@ granted does NOT imply accounts@ — the whole model.
    expect(access(MB_ACCOUNTS.id).access).toBe('none')
  })

  it('omits deactivated staff from the roster', async () => {
    const state = adminState()
    state.profiles = state.profiles.map(p => p.id === COACH_A.id ? { ...p, active: false } : p)
    setupDb(state)
    const { body } = await list()
    expect(body.data.staff.map(s => s.profile_id)).not.toContain(COACH_A.id)
  })

  it('is an empty list, not an error, at a studio with no accounts', async () => {
    setupDb(adminState({ mailboxes: [] }))
    const { res, body } = await list()
    expect(res.status).toBe(200)
    expect(body.data.mailboxes).toEqual([])
  })
})

describe('POST — adding an account', () => {
  it('stores the address normalised and the label trimmed', async () => {
    const { res, body } = await post({ address: '  Sales@UN1TDublin.com ', label: '  Sales  ' })
    expect(res.status).toBe(201)
    const payload = insertsInto(db, 'email_mailboxes')[0].payload
    expect(payload.address).toBe('sales@un1tdublin.com')
    expect(payload.label).toBe('Sales')
    expect(payload.location_id).toBe(LOC_A)
    expect(payload.active).toBe(true)
    expect(body.data.mailbox.address).toBe('sales@un1tdublin.com')
  })

  it('refuses a malformed address with a sentence, not a constraint name', async () => {
    const { res, body } = await post({ address: 'sales@localhost', label: 'Sales' })
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/valid email address/i)
    expect(body.error).not.toMatch(/constraint|check|22P02|23514/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses a label over 40 characters in plain words', async () => {
    const { res, body } = await post({ address: 'sales@un1tdublin.com', label: 'x'.repeat(41) })
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/40 characters/)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses an address that already exists AT THIS studio, naming the account', async () => {
    const { res, body } = await post({ address: MB_ACCOUNTS.address.toUpperCase(), label: 'Billing' })
    expect(res.status).toBe(409)
    expect(body.error).toMatch(/already set up at this studio/i)
    expect(body.error).toMatch(/Accounts/)
    expect(writesTo(db)).toEqual([])
  })

  it('points at the deactivated row rather than letting a duplicate be created', async () => {
    setupDb(adminState({ mailboxes: [{ ...MB_STUDIO }, { ...MB_ACCOUNTS, active: false }] }))
    const { res, body } = await post({ address: MB_ACCOUNTS.address, label: 'Billing' })
    expect(res.status).toBe(409)
    expect(body.error).toMatch(/deactivated/i)
    expect(body.error).toMatch(/Reactivate/i)
    expect(writesTo(db)).toEqual([])
  })

  it('EXPLAINS THE ESTATE-WIDE RULE when the address belongs to another studio', async () => {
    // The confusing one: UNIQUE(lower(address)) is global, and this owner
    // cannot see Hatch Street at all — a raw 23505 would read as a form bug.
    const { res, body } = await post({ address: MB_OTHER_LOCATION.address, label: 'Studio' })
    expect(res.status).toBe(409)
    expect(body.error).toMatch(/another studio/i)
    expect(body.error).toMatch(/only one account across the whole estate/i)
    expect(body.error).not.toMatch(/duplicate key|unique constraint/i)
    // …and it does NOT name the studio for an owner: cross-tenant disclosure.
    expect(body.error).not.toMatch(/Hatch/)
    expect(writesTo(db)).toEqual([])
  })

  it('names the other studio for a master, who can see the whole estate anyway', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const { body } = await post({ address: MB_OTHER_LOCATION.address, label: 'Studio' })
    expect(body.error).toMatch(/UN1T Hatch Street/)
  })

  it('does not treat a lookalike address as taken (ILIKE is a pattern, not an =)', async () => {
    // `_` is a LIKE wildcard AND a legal email character. Unescaped, the
    // clash lookup for a_b@ would match axb@ and refuse a valid address.
    setupDb(adminState({ mailboxes: [{ ...MB_STUDIO, address: 'axb@un1tdublin.com' }] }))
    const { res } = await post({ address: 'a_b@un1tdublin.com', label: 'Odd' })
    expect(res.status).toBe(201)
  })

  it('creating a second default leaves exactly one default at the location', async () => {
    const { res } = await post({ address: 'sales@un1tdublin.com', label: 'Sales', is_default: true })
    expect(res.status).toBe(201)
    const atLocA = db._state.mailboxes.filter(m => m.location_id === LOC_A)
    expect(atLocA.filter(m => m.is_default)).toHaveLength(1)
    expect(atLocA.find(m => m.is_default).address).toBe('sales@un1tdublin.com')
    // The incumbent was cleared, not deleted.
    expect(atLocA.find(m => m.id === MB_STUDIO.id).is_default).toBe(false)
    expect(atLocA).toHaveLength(3)
  })

  it('clears only THIS location’s default', async () => {
    await post({ address: 'sales@un1tdublin.com', label: 'Sales', is_default: true })
    expect(db._state.mailboxes.find(m => m.id === MB_OTHER_LOCATION.id).is_default).toBe(true)
    const clears = updatesTo(db, 'email_mailboxes')
    expect(clears[0].filters).toContainEqual(['eq', 'location_id', LOC_A])
  })

  it('leaves the existing default alone when is_default is not asked for', async () => {
    await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    expect(updatesTo(db, 'email_mailboxes')).toEqual([])
    expect(db._state.mailboxes.find(m => m.id === MB_STUDIO.id).is_default).toBe(true)
  })

  it('writes an audit row naming the actor and the account', async () => {
    await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    const audits = insertsInto(db, 'audit_events')
    expect(audits).toHaveLength(1)
    expect(audits[0].payload.action).toBe('email_mailbox.created')
    expect(audits[0].payload.actor_id).toBe(OWNER_A.id)
    expect(audits[0].payload.location_id).toBe(LOC_A)
    // A mailbox is not a profile, so target_profile_id stays null (the FK
    // would reject it and the row would be silently dropped).
    expect(audits[0].payload.target_profile_id).toBeNull()
    expect(audits[0].payload.target_resource).toMatch(/^email_mailbox\//)
  })

  it('does not audit a refused create', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    expect(insertsInto(db, 'audit_events')).toEqual([])
  })

  it('fails loudly when the mailbox table is unreadable rather than reporting success', async () => {
    // The clash pre-check is the first thing to touch the table, so an
    // injected failure lands there — and must NOT fall through to an insert
    // that skips the global-uniqueness check.
    setupDb(adminState({ errors: { email_mailboxes: { code: '42501', message: 'permission denied for table email_mailboxes' } } }))
    const { res, body } = await post({ address: 'sales@un1tdublin.com', label: 'Sales' })
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(insertsInto(db, 'email_mailboxes')).toEqual([])
  })

  it('refuses a location the caller cannot reach even when the path id is another studio', async () => {
    const { res } = await post({ address: 'x@y.ie', label: 'X' }, { params: { id: LOC_B } })
    expect(res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })
})

// MAILBOX-UNREACHABLE.1 — the card cannot warn about an address it was never
// told about, so the verdict has to ride on the list response. These assert
// the ROUTE's contract (a verdict per row, and a list that survives without
// one); the four states themselves are proven in
// src/lib/mail/mailbox-reachability.test.js.
describe('GET — whether each address can actually receive', () => {
  it('attaches a verdict to every mailbox', async () => {
    const { body } = await list()
    for (const m of body.data.mailboxes) {
      expect(m.reachability).toBeTruthy()
      expect(typeof m.reachability.state).toBe('string')
    }
  })

  it('flags a studio whose domain delivers somewhere else, and ships the copy with it', async () => {
    resolveMx.mockResolvedValue(GOOGLE_MX)
    const { body } = await list()
    const studio = body.data.mailboxes.find(m => m.id === MB_STUDIO.id)
    expect(studio.reachability.state).toBe('unreachable')
    // The sentences are built server-side: the card is a client component and
    // the reachability module imports node:dns, so it cannot build them itself.
    expect(studio.reachability.notice.chip).toBe('Cannot receive')
    expect(studio.reachability.notice.detail).toContain('un1tdublin.com')
    expect(studio.reachability.notice.detail).toContain('aspmx.l.google.com')
  })

  it('says NOTHING about an address whose domain does deliver here — however quiet it is', async () => {
    // adminState() files no inbound mail at all. A reachable mailbox with zero
    // arrivals must still render clean, or the warning stops being read.
    const { body } = await list()
    const studio = body.data.mailboxes.find(m => m.id === MB_STUDIO.id)
    expect(studio.reachability.state).toBe('ok')
    expect(studio.reachability.notice).toBeNull()
  })

  it('still returns the accounts when the lookup blows up entirely', async () => {
    resolveMx.mockImplementation(() => { throw new Error('resolver on fire') })
    const { res, body } = await list()
    expect(res.status).toBe(200)
    expect(body.data.mailboxes.length).toBeGreaterThan(0)
    // Unknown, not "cannot receive": a DNS fault must never invent a fault.
    for (const m of body.data.mailboxes) expect(m.reachability?.notice ?? null).toBeNull()
  })
})
