// ROLETESTS.1 — who can read and write what, on real Postgres, as each kind of
// signed-in session. The rules are the live ones (supabase/schema/access.json).
// These are the tables the phone and the browser reach directly; server routes
// use the service role and are judged in application code instead.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRoleDb, snapshot, access } from './helpers/role-db.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG1 = id(1)
const ORG2 = id(2)
const A = id(11)
const B = id(12)
const C = id(13)

const U = {
  master: id(101), ownerA: id(102), managerA: id(103), headA: id(104), receptionA: id(105), staffA: id(106),
  staffB: id(107), inactiveA: id(108), deletedA: id(109), member: id(110), stranger: id(111),
}
const R = (base) => ({ a: id(base + 1), b: id(base + 2), c: id(base + 3), x: id(base + 4) })
const CONTACT = R(200)

// Which of the seeded rows (a = studio A, b = studio B, c = other organisation)
// each session should see.
const EVERYONE_NONE = { inactiveA: '', deletedA: '', member: '', stranger: '' }
const CLIENT_READS = (over) => ({ ...EVERYONE_NONE, ...over })
const PIPELINE = CLIENT_READS({ master: 'abc', ownerA: 'a', managerA: 'a', headA: 'a', receptionA: '', staffA: '', staffB: '' })
const FRONT_DESK = CLIENT_READS({ master: 'abc', ownerA: 'a', managerA: 'a', headA: 'a', receptionA: 'a', staffA: '', staffB: '' })
const ANY_MEMBER = CLIENT_READS({ master: 'abc', ownerA: 'a', managerA: 'a', headA: 'a', receptionA: 'a', staffA: 'a', staffB: 'b' })

const READS = [
  ['deals', PIPELINE],
  ['notes', PIPELINE],
  ['bookings', FRONT_DESK],
  ['whatsapp_conversations', FRONT_DESK],
  ['whatsapp_messages', FRONT_DESK],
  ['whatsapp_templates', FRONT_DESK],
  ['activities', ANY_MEMBER],
  ['class_occurrences', ANY_MEMBER],
  ['pipelines', ANY_MEMBER],
]
const BASE = { deals: 300, notes: 320, bookings: 340, whatsapp_conversations: 360, whatsapp_messages: 380, whatsapp_templates: 400, activities: 420, class_occurrences: 440, pipelines: 460 }

let db
const letters = (rows, map) => rows.map((r) => Object.entries(map).find(([, v]) => v === r.id)?.[0] ?? '?').sort().join('')
const read = (who, sql) => db.as(U[who], (q) => q(sql))
const refused = async (p) => { await expect(p).rejects.toMatchObject({ code: '42501' }) }

beforeAll(async () => {
  db = await createRoleDb()
  await db.seed('organizations', [{ id: ORG1, name: 'One' }, { id: ORG2, name: 'Two' }])
  await db.seed('locations', [[A, ORG1], [B, ORG1], [C, ORG2]].map(([l, organization_id]) => ({ id: l, organization_id, name: l, active: true, features: {}, settings: { secret: 1 } })))
  const profile = (uid, role = 'staff', over = {}) => ({ id: uid, role, active: true, deleted_at: null, employment_type: 'fte', full_name: 'Test Person', ...over })
  await db.seed('profiles', [
    profile(U.master, 'master'), profile(U.ownerA), profile(U.managerA), profile(U.headA), profile(U.receptionA), profile(U.staffA), profile(U.staffB),
    profile(U.inactiveA, 'staff', { active: false }), profile(U.deletedA, 'staff', { active: false, deleted_at: '2026-01-01T00:00:00Z' }),
  ])
  await db.seed('profile_locations', [
    [U.ownerA, A, 'owner'], [U.managerA, A, 'manager'], [U.headA, A, 'head_coach'], [U.receptionA, A, 'reception'], [U.staffA, A, 'staff'],
    [U.staffB, B, 'staff'], [U.inactiveA, A, 'manager'], [U.deletedA, A, 'manager'],
  ].map(([profile_id, location_id, role]) => ({ profile_id, location_id, role, permissions: {} })))
  await db.seed('contacts', [
    { id: CONTACT.a, location_id: A, user_id: U.member, name: 'A' }, { id: CONTACT.b, location_id: B, name: 'B' },
    { id: CONTACT.c, location_id: C, name: 'C' }, { id: CONTACT.x, location_id: B, name: 'Shared' },
  ])
  await db.seed('contact_studios', [{ contact_id: CONTACT.x, location_id: A, status: 'lead' }])
  for (const [table] of READS) {
    const ids = R(BASE[table])
    await db.seed(table, [[ids.a, A], [ids.b, B], [ids.c, C]].map(([rowId, location_id]) => ({ id: rowId, location_id })))
  }
  await db.seed('rosters', [{ id: id(501), location_id: A, status: 'published' }, { id: id(502), location_id: A, status: 'draft' }, { id: id(503), location_id: B, status: 'published' }])
  await db.seed('shift_blocks', [{ id: id(511), location_id: A, roster_id: id(501) }, { id: id(512), location_id: A, roster_id: id(502) }, { id: id(513), location_id: B, roster_id: id(503) }])
  await db.seed('shift_assignments', [{ id: id(521), block_id: id(511), profile_id: U.staffA }, { id: id(522), block_id: id(512), profile_id: U.staffA }, { id: id(523), block_id: id(513), profile_id: U.staffB }])
  await db.seed('time_off_requests', [{ id: id(531), location_id: A, profile_id: U.staffA }, { id: id(532), location_id: B, profile_id: U.staffB }])
  await db.seed('heart_rate_sessions', [{ id: id(541), location_id: A, contact_id: CONTACT.a }, { id: id(542), location_id: C, contact_id: CONTACT.c }])
}, 60_000)

afterAll(async () => { await db?.close() })

describe('the captured rules match the schema snapshot', () => {
  it('both files describe the same migration', () => {
    expect(access.through_migration).toBe(snapshot.through_migration)
  })
})

describe('reading a studio\'s rows', () => {
  for (const [table, expected] of READS) {
    it.each(Object.entries(expected))(`${table}: %s sees "%s"`, async (who, want) => {
      expect(letters(await read(who, `select id from public.${table}`), R(BASE[table]))).toBe(want)
    })
  }
})

describe('contacts', () => {
  it.each([
    ['master', 'abcx'], ['ownerA', 'ax'], ['managerA', 'ax'], ['headA', 'ax'], ['receptionA', 'ax'], ['staffA', 'ax'],
    ['staffB', 'bx'], ['inactiveA', ''], ['deletedA', ''], ['member', 'a'], ['stranger', ''],
  ])('%s sees "%s"', async (who, want) => {
    expect(letters(await read(who, 'select id from public.contacts'), CONTACT)).toBe(want)
  })
  it('no signed-in session can write a contact', async () => {
    await refused(read('master', `update public.contacts set name = 'X'`))
    await refused(read('member', `update public.contacts set name = 'X' where user_id = '${U.member}'`))
    await refused(read('ownerA', `insert into public.contacts (id, location_id) values ('${id(299)}', '${A}')`))
    await refused(read('ownerA', `delete from public.contacts`))
  })
})

describe('the roster', () => {
  const ids = (rows) => rows.map((r) => r.id).sort()
  it('managers see drafts; other staff see only what is published', async () => {
    expect(ids(await read('managerA', 'select id from public.shift_blocks'))).toEqual([id(511), id(512)])
    expect(ids(await read('headA', 'select id from public.rosters'))).toEqual([id(501), id(502)])
    expect(ids(await read('staffA', 'select id from public.shift_blocks'))).toEqual([id(511)])
    expect(ids(await read('staffA', 'select id from public.rosters'))).toEqual([id(501)])
    expect(ids(await read('staffA', 'select id from public.shift_assignments'))).toEqual([id(521)])
  })
  it('another studio\'s roster stays hidden, and a signed-out or deleted session sees none', async () => {
    expect(ids(await read('staffB', 'select id from public.shift_blocks'))).toEqual([id(513)])
    expect(await read('deletedA', 'select id from public.shift_blocks')).toEqual([])
    expect(await read('member', 'select id from public.shift_assignments')).toEqual([])
  })
  it('nobody signed in can change a shift', async () => {
    await refused(read('managerA', `update public.shift_assignments set status = 'x'`))
    await refused(read('managerA', `delete from public.shift_blocks`))
    await refused(read('master', `insert into public.rosters (id, location_id) values ('${id(599)}', '${A}')`))
  })
  it('leave: your own, or everyone\'s if you manage the studio', async () => {
    expect(ids(await read('staffA', 'select id from public.time_off_requests'))).toEqual([id(531)])
    expect(ids(await read('managerA', 'select id from public.time_off_requests'))).toEqual([id(531)])
    expect(await read('receptionA', 'select id from public.time_off_requests')).toEqual([])
    expect(ids(await read('master', 'select id from public.time_off_requests'))).toEqual([id(531), id(532)])
  })
})

describe('a member', () => {
  it('sees their own session and nobody else\'s', async () => {
    expect((await read('member', 'select id from public.heart_rate_sessions')).map((r) => r.id)).toEqual([id(541)])
  })
})

describe('writes follow the studio', () => {
  it('a manager can add a deal at their studio and not at another', async () => {
    await db.as(U.managerA, async (q) => { await q(`insert into public.deals (id, location_id) values ('${id(399)}', '${A}')`) })
    await refused(read('managerA', `insert into public.deals (id, location_id) values ('${id(398)}', '${B}')`))
    await refused(read('staffA', `insert into public.deals (id, location_id) values ('${id(397)}', '${A}')`))
  })
  it('an update or delete cannot reach another studio\'s rows', async () => {
    const hit = await read('managerA', `update public.deals set title = 'x' where id = '${R(300).b}' returning id`)
    expect(hit).toEqual([])
    expect(await read('managerA', `delete from public.notes where id = '${R(320).b}' returning id`)).toEqual([])
  })
  it('an owner can manage memberships only at their own studio, and a manager cannot promote themselves', async () => {
    await refused(read('ownerA', `insert into public.profile_locations (profile_id, location_id, role) values ('${U.ownerA}', '${B}', 'owner')`))
    expect(await read('managerA', `update public.profile_locations set role = 'owner' where profile_id = '${U.managerA}' returning profile_id`)).toEqual([])
    await refused(read('managerA', `insert into public.profile_locations (profile_id, location_id, role) values ('${U.managerA}', '${A}', 'owner')`))
  })
})

describe('closed to every client session', () => {
  it.each(['profiles', 'audit_events', 'contact_preferences', 'contact_location_preferences', 'consent_log', 'cars', 'company_settings', 'org_settings', 'campaigns', 'staff_attendance_events', 'contact_studios'])('%s', async (table) => {
    await refused(read('master', `select 1 from public.${table} limit 1`))
    await refused(read('ownerA', `select 1 from public.${table} limit 1`))
    await refused(db.asAnon((q) => q(`select 1 from public.${table} limit 1`)))
  })
  it('api keys: row-level security with no policy returns nothing to any session', async () => {
    await db.pg.query(`insert into public.api_keys (id, location_id) values ('${id(601)}', '${A}')`).catch(async () => db.pg.query(`insert into public.api_keys (id) values ('${id(601)}')`))
    expect(await read('master', 'select id from public.api_keys')).toEqual([])
    expect(await read('ownerA', 'select id from public.api_keys')).toEqual([])
  })
  it('location settings are withheld even from the studio\'s owner', async () => {
    expect((await read('ownerA', 'select id from public.locations')).map((r) => r.id)).toEqual([A])
    await refused(read('ownerA', 'select settings from public.locations'))
    await refused(read('master', 'select * from public.locations'))
  })
})

describe('signed out', () => {
  it.each(['contacts', 'deals', 'notes', 'activities', 'bookings', 'whatsapp_messages', 'whatsapp_conversations', 'shift_blocks', 'shift_assignments', 'rosters', 'time_off_requests'])('%s is refused', async (table) => {
    await refused(db.asAnon((q) => q(`select 1 from public.${table} limit 1`)))
  })
})
