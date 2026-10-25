// ORGCONTACTS.1 — src/lib/contact-studios.js, the one reader and writer of
// contact_studios from app code (spec §2.1-2.2). Every function takes the
// service-role client, never throws, and answers a read error as { ok: false,
// error }. Fictional ids only: the repo is public.

import { describe, it, expect } from 'vitest'
import {
  KINDS, STATUSES, SOURCES, IN_CHUNK, MEMBERSHIP_FACT_COLUMNS,
  upsertContactStudio, touchContactStudio, setMembershipFacts, contactsAtStudio, studiosOfContact, studiosOfContacts,
  hasRelationshipAt, primaryStudioOf, pickStudioByActivity,
} from './contact-studios.js'

// A chainable stand-in for the supabase builder. `handlers[table](call)`
// answers the awaited chain; a table no handler names answers { data: [] }.
// Every chain is recorded on `ops` with its op, payload, filters and options.
function fakeDb(handlers = {}) {
  const ops = []
  return {
    ops,
    from(table) {
      const call = { table, op: 'select', payload: null, filters: [], select: null, order: [], range: null, limit: null, onConflict: null }
      const b = {
        select(cols) { call.select = cols; return b },
        insert(p) { call.op = 'insert'; call.payload = p; return b },
        upsert(p, o) { call.op = 'upsert'; call.payload = p; call.onConflict = o?.onConflict ?? null; return b },
        update(p) { call.op = 'update'; call.payload = p; return b },
        eq(c, v) { call.filters.push(['eq', c, v]); return b },
        neq(c, v) { call.filters.push(['neq', c, v]); return b },
        in(c, v) { call.filters.push(['in', c, v]); return b },
        is(c, v) { call.filters.push(['is', c, v]); return b },
        lt(c, v) { call.filters.push(['lt', c, v]); return b },
        gt(c, v) { call.filters.push(['gt', c, v]); return b },
        or(s) { call.filters.push(['or', s]); return b },
        order(c, o) { call.order.push([c, o]); return b },
        range(a, z) { call.range = [a, z]; return b },
        limit(n) { call.limit = n; return b },
        then(resolve, reject) {
          ops.push(call)
          return Promise.resolve().then(() => (handlers[table] ? handlers[table](call) : { data: [], error: null })).then(resolve, reject)
        },
      }
      return b
    },
  }
}
const filter = (call, op, col) => call.filters.find((f) => f[0] === op && f[1] === col)?.[2]
const ERR = { data: null, error: { code: '42501', message: 'boom' } }
const A = 'a0000000-0000-4000-8000-000000000001'
const B = 'a0000000-0000-4000-8000-000000000002'
const C = 'a0000000-0000-4000-8000-000000000003'
const CT = 'c0000000-0000-4000-8000-000000000001'
const CT2 = 'c0000000-0000-4000-8000-000000000002'
const NOW = '2026-10-20T10:00:00.000Z'

describe('constants', () => {
  it('name the lifecycle values the table checks', () => {
    expect(KINDS).toEqual(['member', 'client', 'lead'])
    expect(STATUSES).toEqual(['active', 'ended'])
    expect(SOURCES).toEqual(['glofox', 'un1t_online', 'lead_form', 'deal', 'manual', 'import'])
    expect(IN_CHUNK).toBe(150)
  })
})

describe('upsertContactStudio', () => {
  it('upserts on (contact_id, location_id); an active row carries ended_at null and never a last_seen_at', async () => {
    const db = fakeDb({ contact_studios: () => ({ data: [{ contact_id: CT, location_id: A, kind: 'member' }], error: null }) })
    const r = await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'member', source: 'glofox', nowIso: NOW })
    expect(r).toEqual({ ok: true, row: { contact_id: CT, location_id: A, kind: 'member' } })
    const [up] = db.ops
    expect(up.op).toBe('upsert')
    expect(up.onConflict).toBe('contact_id,location_id')
    expect(up.payload).toEqual({ contact_id: CT, location_id: A, kind: 'member', status: 'active', source: 'glofox', ended_at: null, updated_at: NOW })
    expect(up.payload).not.toHaveProperty('last_seen_at')
    expect(up.payload).not.toHaveProperty('first_seen_at')
    expect(db.ops).toHaveLength(1)
  })
  it("status 'ended' stamps ended_at = nowIso; stageSlug is written only when given (null clears it)", async () => {
    // source deal is not a membership source, so each write reads the row first (C1); judge the upserts.
    const db = fakeDb({ contact_studios: (call) => (call.op === 'select' ? { data: [], error: null } : { data: [{}], error: null }) })
    await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'deal', status: 'ended', stageSlug: null, nowIso: NOW })
    const upserts = () => db.ops.filter((o) => o.op === 'upsert')
    expect(upserts()[0].payload).toMatchObject({ status: 'ended', ended_at: NOW, stage_slug: null })
    await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'deal', stageSlug: 'waitlist', nowIso: NOW })
    expect(upserts()[1].payload.stage_slug).toBe('waitlist')
  })
  it('firstSeenAt is written with a second guarded update that only ever moves it EARLIER', async () => {
    const db = fakeDb({ contact_studios: (call) => ({ data: call.op === 'upsert' ? [{ contact_id: CT }] : [{ contact_id: CT }], error: null }) })
    const r = await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'client', source: 'un1t_online', firstSeenAt: '2026-01-01T00:00:00.000Z', nowIso: NOW })
    expect(r.ok).toBe(true)
    expect(db.ops[0].payload).not.toHaveProperty('first_seen_at')
    const guard = db.ops[1]
    expect(guard.op).toBe('update')
    expect(guard.payload).toEqual({ first_seen_at: '2026-01-01T00:00:00.000Z' })
    expect(filter(guard, 'eq', 'contact_id')).toBe(CT)
    expect(filter(guard, 'eq', 'location_id')).toBe(A)
    expect(filter(guard, 'gt', 'first_seen_at')).toBe('2026-01-01T00:00:00.000Z')
  })
  it('refuses a kind, status or source the table would refuse, without a write', async () => {
    const db = fakeDb()
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'vip', source: 'glofox' })).toMatchObject({ ok: false })
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'facebook' })).toMatchObject({ ok: false })
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'deal', status: 'paused' })).toMatchObject({ ok: false })
    expect(await upsertContactStudio(db, { contactId: null, locationId: A, kind: 'lead', source: 'deal' })).toMatchObject({ ok: false })
    expect(db.ops).toEqual([])
  })
  // C1 (final review) — a public form (race / lead / class-booking signup) at
  // a sibling studio writes a lead_form row for the person; it must never
  // turn a member's or client's row (source glofox / un1t_online) into a lead:
  // the Glofox readers, Mia and PIPEEXCL.2 read that source, and after mig 768
  // the row is the only record of the Glofox link.
  it('never weakens a membership-sourced row: a lead_form write onto a glofox row reads it and keeps it, writing nothing', async () => {
    const existing = { contact_id: CT, location_id: A, kind: 'member', status: 'active', source: 'glofox', stage_slug: null, first_seen_at: NOW, last_seen_at: null, ended_at: null }
    const db = fakeDb({ contact_studios: (call) => (call.op === 'select' ? { data: [existing], error: null } : { data: [{ ...existing, kind: 'lead', source: 'lead_form' }], error: null }) })
    const r = await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'lead_form', nowIso: NOW })
    expect(r).toEqual({ ok: true, row: existing, kept: true })
    expect(db.ops.map((o) => o.op)).toEqual(['select'])
    expect(filter(db.ops[0], 'eq', 'contact_id')).toBe(CT)
    expect(filter(db.ops[0], 'eq', 'location_id')).toBe(A)
  })

  it('a non-membership write onto a non-membership row, or onto no row, still writes; a membership write never reads first', async () => {
    const lead = { contact_id: CT, location_id: A, kind: 'lead', status: 'active', source: 'deal', stage_slug: null }
    let db = fakeDb({ contact_studios: (call) => (call.op === 'select' ? { data: [lead], error: null } : { data: [{ ...lead, source: 'lead_form' }], error: null }) })
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'lead_form', nowIso: NOW })).toMatchObject({ ok: true, row: { source: 'lead_form' } })
    expect(db.ops.map((o) => o.op)).toEqual(['select', 'upsert'])

    db = fakeDb({ contact_studios: (call) => (call.op === 'select' ? { data: [], error: null } : { data: [{ ...lead, source: 'lead_form' }], error: null }) })
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'lead_form', nowIso: NOW })).toMatchObject({ ok: true })
    expect(db.ops.map((o) => o.op)).toEqual(['select', 'upsert'])

    db = fakeDb({ contact_studios: (call) => (call.op === 'select' ? { throw: true } : { data: [{ ...lead, source: 'glofox', kind: 'member' }], error: null }) })
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'member', source: 'glofox', nowIso: NOW })).toMatchObject({ ok: true })
    expect(db.ops.map((o) => o.op)).toEqual(['upsert'])
  })

  it('a failed read before a non-membership write is { ok: false, error }: the row is not guessed at', async () => {
    const db = fakeDb({ contact_studios: (call) => (call.op === 'select' ? ERR : { data: [], error: null }) })
    expect(await upsertContactStudio(db, { contactId: CT, locationId: A, kind: 'lead', source: 'lead_form' })).toEqual({ ok: false, error: expect.stringContaining('boom') })
    expect(db.ops.map((o) => o.op)).toEqual(['select'])
  })

  it('a failed write is { ok: false, error } and never throws; a zero-row upsert is an error too', async () => {
    expect(await upsertContactStudio(fakeDb({ contact_studios: () => ERR }), { contactId: CT, locationId: A, kind: 'lead', source: 'deal' })).toEqual({ ok: false, error: expect.stringContaining('boom') })
    expect(await upsertContactStudio(fakeDb({ contact_studios: () => ({ data: [], error: null }) }), { contactId: CT, locationId: A, kind: 'lead', source: 'deal' })).toMatchObject({ ok: false })
    expect(await upsertContactStudio(fakeDb({ contact_studios: () => { throw new Error('network') } }), { contactId: CT, locationId: A, kind: 'lead', source: 'deal' })).toEqual({ ok: false, error: 'network' })
  })
})

// ORGCONTACTS.7 (mig 770) — the un1t sync's one write of the membership facts.
describe('setMembershipFacts', () => {
  const rowsBack = { data: [{ contact_id: CT }], error: null }
  it('active: one update of plan / status / ended_at null, then a guarded membership_since stamp only where null', async () => {
    const db = fakeDb({ contact_studios: () => rowsBack })
    const r = await setMembershipFacts(db, { contactId: CT, locationId: A, plan: 'Founding Membership — Unlimited', status: 'active', nowIso: NOW })
    expect(r).toEqual({ ok: true, updated: true })
    expect(db.ops.map((o) => o.op)).toEqual(['update', 'update'])
    expect(db.ops[0].payload).toEqual({ membership_plan: 'Founding Membership — Unlimited', membership_status: 'active', membership_ended_at: null, updated_at: NOW })
    expect(filter(db.ops[0], 'eq', 'contact_id')).toBe(CT)
    expect(filter(db.ops[0], 'eq', 'location_id')).toBe(A)
    expect(db.ops[0].select).toBe('contact_id')
    expect(db.ops[1].payload).toEqual({ membership_since: NOW })
    expect(filter(db.ops[1], 'is', 'membership_since')).toBeNull()
    expect(filter(db.ops[1], 'eq', 'contact_id')).toBe(CT)
  })
  it('ended: one update with membership_ended_at = endedAt ?? nowIso, guarded on the row still being active (never moves an earlier end date), no plan change, no since stamp', async () => {
    let db = fakeDb({ contact_studios: () => rowsBack })
    expect(await setMembershipFacts(db, { contactId: CT, locationId: A, status: 'ended', endedAt: '2026-09-01T00:00:00.000Z', nowIso: NOW })).toEqual({ ok: true, updated: true })
    expect(db.ops.map((o) => o.op)).toEqual(['update'])
    expect(db.ops[0].payload).toEqual({ membership_status: 'ended', membership_ended_at: '2026-09-01T00:00:00.000Z', updated_at: NOW })
    expect(filter(db.ops[0], 'eq', 'membership_status')).toBe('active') // an already-ended row is untouched: updated:false
    db = fakeDb({ contact_studios: () => rowsBack })
    await setMembershipFacts(db, { contactId: CT, locationId: A, status: 'ended', nowIso: NOW })
    expect(db.ops[0].payload.membership_ended_at).toBe(NOW)
  })
  it('a zero-row update is { ok: true, updated: false } with no second write; a failed write is { ok: false }; a bad status or missing id writes nothing', async () => {
    let db = fakeDb({ contact_studios: () => ({ data: [], error: null }) })
    expect(await setMembershipFacts(db, { contactId: CT, locationId: A, plan: 'x', status: 'active', nowIso: NOW })).toEqual({ ok: true, updated: false })
    expect(db.ops.map((o) => o.op)).toEqual(['update'])
    db = fakeDb({ contact_studios: () => ERR })
    expect(await setMembershipFacts(db, { contactId: CT, locationId: A, plan: 'x', status: 'active' })).toEqual({ ok: false, error: expect.stringContaining('boom') })
    db = fakeDb()
    expect(await setMembershipFacts(db, { contactId: CT, locationId: A, status: 'paused' })).toMatchObject({ ok: false })
    expect(await setMembershipFacts(db, { contactId: null, locationId: A, status: 'active' })).toMatchObject({ ok: false })
    expect(db.ops).toEqual([])
  })
  it('never names kind, status, source, stage_slug, first_seen_at or last_seen_at', async () => {
    const db = fakeDb({ contact_studios: () => rowsBack })
    await setMembershipFacts(db, { contactId: CT, locationId: A, plan: 'x', status: 'active', nowIso: NOW })
    for (const op of db.ops) for (const k of Object.keys(op.payload)) expect(['membership_plan', 'membership_status', 'membership_since', 'membership_ended_at', 'updated_at']).toContain(k)
  })
})

it('ROW_COLUMNS carries the four membership columns (every studiosOfContact reader sees the plan); MEMBERSHIP_FACT_COLUMNS names them', async () => {
  expect(MEMBERSHIP_FACT_COLUMNS).toBe('membership_plan, membership_status, membership_since, membership_ended_at')
  const db = fakeDb({ contact_studios: () => ({ data: [], error: null }) })
  await studiosOfContact(db, CT)
  for (const col of MEMBERSHIP_FACT_COLUMNS.split(', ')) expect(db.ops[0].select).toContain(col)
})

describe('touchContactStudio', () => {
  it('moves last_seen_at forward only: update guarded on null-or-earlier; zero rows is ok, touched:false', async () => {
    const db = fakeDb({ contact_studios: () => ({ data: [{ contact_id: CT }], error: null }) })
    expect(await touchContactStudio(db, { contactId: CT, locationId: A, at: NOW })).toEqual({ ok: true, touched: true })
    const [op] = db.ops
    expect(op.op).toBe('update')
    expect(op.payload).toEqual({ last_seen_at: NOW })
    expect(filter(op, 'eq', 'contact_id')).toBe(CT)
    expect(filter(op, 'eq', 'location_id')).toBe(A)
    expect(op.filters.find((f) => f[0] === 'or')[1]).toBe(`last_seen_at.is.null,last_seen_at.lt.${NOW}`)
    const none = fakeDb({ contact_studios: () => ({ data: [], error: null }) })
    expect(await touchContactStudio(none, { contactId: CT, locationId: A, at: NOW })).toEqual({ ok: true, touched: false })
  })
  it('a failed touch is { ok: false, error }; missing ids write nothing', async () => {
    expect(await touchContactStudio(fakeDb({ contact_studios: () => ERR }), { contactId: CT, locationId: A })).toMatchObject({ ok: false })
    const db = fakeDb()
    expect(await touchContactStudio(db, { contactId: CT, locationId: null })).toMatchObject({ ok: false })
    expect(db.ops).toEqual([])
  })
})

describe('contactsAtStudio', () => {
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ contact_id: `c${from + i}`, kind: 'lead', status: 'active', source: 'deal', stage_slug: null, first_seen_at: NOW, last_seen_at: null }))
  it('reads every row at the studio, paged under the 1,000-row cap in a total order', async () => {
    let calls = 0
    const db = fakeDb({ contact_studios: (call) => { calls++; return { data: call.range[0] === 0 ? page(1000, 0) : page(5, 1000), error: null } } })
    const r = await contactsAtStudio(db, A)
    expect(r.ok).toBe(true)
    expect(r.rows).toHaveLength(1005)
    expect(calls).toBe(2)
    expect(filter(db.ops[0], 'eq', 'location_id')).toBe(A)
    expect(db.ops[0].order).toEqual([['contact_id', { ascending: true }]])
    expect(db.ops[0].range).toEqual([0, 999])
    expect(db.ops[1].range).toEqual([1000, 1999])
  })
  it('kinds and status narrow the read; contactIds are chunked at 150', async () => {
    const ids = Array.from({ length: 151 }, (_, i) => `c${i}`)
    const db = fakeDb({ contact_studios: (call) => ({ data: filter(call, 'in', 'contact_id').slice(0, 2).map((id) => ({ contact_id: id, kind: 'member', status: 'active' })), error: null }) })
    const r = await contactsAtStudio(db, A, { kinds: ['member'], status: 'active', contactIds: ids })
    expect(r.ok).toBe(true)
    expect(db.ops).toHaveLength(2)
    expect(filter(db.ops[0], 'in', 'contact_id')).toHaveLength(150)
    expect(filter(db.ops[1], 'in', 'contact_id')).toHaveLength(1)
    expect(filter(db.ops[0], 'in', 'kind')).toEqual(['member'])
    expect(filter(db.ops[0], 'eq', 'status')).toBe('active')
    expect(r.rows).toHaveLength(3)   // two from the chunk of 150, one from the chunk of one
  })
  it('an empty contactIds list reads nothing; a read error is { ok: false, error }; no studio is an error', async () => {
    const db = fakeDb()
    expect(await contactsAtStudio(db, A, { contactIds: [] })).toEqual({ ok: true, rows: [] })
    expect(db.ops).toEqual([])
    expect(await contactsAtStudio(fakeDb({ contact_studios: () => ERR }), A)).toMatchObject({ ok: false, error: expect.stringContaining('boom') })
    expect(await contactsAtStudio(fakeDb(), null)).toMatchObject({ ok: false })
  })
})

describe('studiosOfContact / studiosOfContacts', () => {
  const rowsFor = {
    contact_studios: (call) => ({ data: [
      { contact_id: CT, location_id: A, kind: 'member', status: 'active', source: 'glofox', stage_slug: null, first_seen_at: NOW, last_seen_at: NOW },
      { contact_id: CT, location_id: B, kind: 'lead', status: 'ended', source: 'deal', stage_slug: null, first_seen_at: NOW, last_seen_at: null },
      { contact_id: CT, location_id: C, kind: 'client', status: 'active', source: 'un1t_online', stage_slug: null, first_seen_at: NOW, last_seen_at: null },
    ].filter((r) => (filter(call, 'in', 'contact_id') || [filter(call, 'eq', 'contact_id')]).includes(r.contact_id)), error: null }),
    locations: () => ({ data: [
      { id: A, name: 'Alpha', active: true, is_host_anchor: false, organization_id: 'org', membership_source: 'glofox' },
      { id: B, name: 'Beta', active: true, is_host_anchor: false, organization_id: 'org', membership_source: 'un1t_online' },
      { id: C, name: 'Closed', active: false, is_host_anchor: false, organization_id: 'org', membership_source: 'none' },
    ], error: null }),
  }
  it('returns every row with its location, primary order left to the caller', async () => {
    const r = await studiosOfContact(fakeDb(rowsFor), CT)
    expect(r.ok).toBe(true)
    expect(r.rows.map((x) => [x.location_id, x.kind, x.status, x.location.name])).toEqual([[A, 'member', 'active', 'Alpha'], [B, 'lead', 'ended', 'Beta'], [C, 'client', 'active', 'Closed']])
  })
  it('activeOnly drops ended rows and rows at inactive or host-anchor studios (Review Focus 1)', async () => {
    const r = await studiosOfContact(fakeDb(rowsFor), CT, { activeOnly: true })
    expect(r.rows.map((x) => x.location_id)).toEqual([A])
    const anchor = { ...rowsFor, locations: () => ({ data: [{ id: A, name: 'Host', active: true, is_host_anchor: true, organization_id: 'org', membership_source: 'none' }], error: null }) }
    expect((await studiosOfContact(fakeDb(anchor), CT, { activeOnly: true })).rows).toEqual([])
  })
  it('a location the read cannot name is kept with location: null (never dropped silently)', async () => {
    const missing = { ...rowsFor, locations: () => ({ data: [], error: null }) }
    const r = await studiosOfContact(fakeDb(missing), CT)
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0].location).toBeNull()
  })
  it('studiosOfContacts groups by contact, chunked at 150; a read error is { ok: false }', async () => {
    const r = await studiosOfContacts(fakeDb(rowsFor), [CT, CT2])
    expect(r.ok).toBe(true)
    expect(r.byContact.get(CT)).toHaveLength(3)
    expect(r.byContact.has(CT2)).toBe(false)
    expect(await studiosOfContacts(fakeDb({ contact_studios: () => ERR }), [CT])).toMatchObject({ ok: false })
    expect(await studiosOfContact(fakeDb({ ...rowsFor, locations: () => ERR }), CT)).toMatchObject({ ok: false })
  })
})

describe('hasRelationshipAt', () => {
  it('any row, ended included (decision 2): the studios among locationIds with a row for the contact', async () => {
    const db = fakeDb({ contact_studios: () => ({ data: [{ location_id: A, status: 'ended' }, { location_id: B, status: 'active' }], error: null }) })
    const r = await hasRelationshipAt(db, CT, [A, B, C])
    expect(r.ok).toBe(true)
    expect([...r.at].sort()).toEqual([A, B])
    expect(filter(db.ops[0], 'eq', 'contact_id')).toBe(CT)
    expect(filter(db.ops[0], 'in', 'location_id')).toEqual([A, B, C])
    expect(db.ops[0].filters.some((f) => f[1] === 'status')).toBe(false)
  })
  it('no studios asked → an empty set with no read; a read error is { ok: false }', async () => {
    const db = fakeDb()
    expect(await hasRelationshipAt(db, CT, [])).toEqual({ ok: true, at: new Set() })
    expect(db.ops).toEqual([])
    expect(await hasRelationshipAt(fakeDb({ contact_studios: () => ERR }), CT, [A])).toMatchObject({ ok: false })
  })
})

describe('primaryStudioOf / pickStudioByActivity (pure)', () => {
  const r = (location_id, status, last_seen_at) => ({ location_id, status, last_seen_at })
  it('primaryStudioOf is the contact row\'s location_id', () => {
    expect(primaryStudioOf({ location_id: A })).toBe(A)
    expect(primaryStudioOf(null)).toBeNull()
  })
  it('the active row with the latest activity wins', () => {
    expect(pickStudioByActivity([r(A, 'active', '2026-10-01'), r(B, 'active', '2026-10-05')], { primaryLocationId: A })).toBe(B)
  })
  it('ended rows are ignored; a null last_seen_at loses to any dated one', () => {
    expect(pickStudioByActivity([r(A, 'ended', '2026-12-01'), r(B, 'active', null), r(C, 'active', '2026-01-01')], { primaryLocationId: null })).toBe(C)
  })
  it('a tie goes to the primary studio when it is one of them, else the lower location_id (Review Focus 3)', () => {
    expect(pickStudioByActivity([r(B, 'active', '2026-10-05'), r(A, 'active', '2026-10-05')], { primaryLocationId: B })).toBe(B)
    expect(pickStudioByActivity([r(B, 'active', '2026-10-05'), r(A, 'active', '2026-10-05')], { primaryLocationId: C })).toBe(A)
    expect(pickStudioByActivity([r(B, 'active', null), r(A, 'active', null)], { primaryLocationId: null })).toBe(A)
  })
  it('no active row → the primary studio, else null', () => {
    expect(pickStudioByActivity([r(A, 'ended', '2026-10-05')], { primaryLocationId: B })).toBe(B)
    expect(pickStudioByActivity([], { primaryLocationId: null })).toBeNull()
    expect(pickStudioByActivity(null, {})).toBeNull()
  })
})
