// QUALS.1 — the qualification data layer: who may read and write what
// (judged on the row, 404 for anything out of reach), that deactivated and
// tombstoned people are never listed or written for, and that a failed read
// is a 500, never an empty list.

import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { mockDb, byTable, filter } = await import('./qualifications-mock-db.test-helpers')
const {
  QUAL_MANAGER_ROLES, QUAL_CATALOGUE_ROLES,
  loadQualificationsPage, createQualificationRecord, updateQualificationRecord, deleteQualificationRecord,
  canEditCatalogue, createQualificationType, updateQualificationType,
  readTemplateRequirements, replaceTemplateRequirements, readBlockQualificationFacts,
} = await import('./qualifications-server')

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const GARAGE = 'loc-garage' // another organisation's studio

const person = (over) => ({ profileRole: 'staff', locations: [{ id: STILL, organization_id: ORG }], ...over })
const manager = person({ id: 'm1', full_name: 'Mia Manager', rolesByLocation: { [STILL]: 'manager' } })
const owner = person({
  id: 'o1', full_name: 'Olive Owner', rolesByLocation: { [STILL]: 'owner', [HATCH]: 'owner' },
  locations: [{ id: STILL, organization_id: ORG }, { id: HATCH, organization_id: ORG }],
})
const headCoach = person({ id: 'h1', full_name: 'Hal Head', rolesByLocation: { [STILL]: 'head_coach' } })
const coach = person({ id: 'c1', full_name: 'Cal Coach', rolesByLocation: { [STILL]: 'staff' } })
const master = { id: 'x1', full_name: 'Max Master', profileRole: 'master', rolesByLocation: {}, locations: [] }

const TYPES = [
  { id: 'fa', organization_id: ORG, name: 'First aid', active: true, sort_order: 10 },
  { id: 'old', organization_id: ORG, name: 'Old cert', active: false, sort_order: 100 },
]
const orgOf = (loc) => (loc === GARAGE ? OTHER_ORG : ORG)
const link = (profile_id, location_id, profile = {}) => ({
  profile_id, location_id,
  locations: { id: location_id, organization_id: orgOf(location_id) },
  profiles: { id: profile_id, full_name: `${profile_id[0].toUpperCase()}${profile_id.slice(1)}`, active: true, deleted_at: null, ...profile },
})
const RECORD = { id: 'r1', organization_id: ORG, profile_id: 'ann', qualification_type_id: 'fa', issued_on: '2026-05-01', expires_on: '2027-05-01', note: null, updated_at: '2026-09-01T00:00:00Z' }

describe('roles', () => {
  it('records: owner and manager; catalogue: owner (masters bypass both)', () => {
    expect(QUAL_MANAGER_ROLES).toEqual(['owner', 'manager'])
    expect(QUAL_CATALOGUE_ROLES).toEqual(['owner'])
  })
})

describe('loadQualificationsPage', () => {
  const pageDb = (over = {}) => mockDb(byTable({
    locations: { data: { id: STILL, organization_id: ORG }, error: null },
    staff_qualification_types: { data: TYPES, error: null },
    profile_locations: { data: [
      link('bob', STILL), link('ann', STILL),
      link('gone', STILL, { active: false, deleted_at: '2026-09-01T00:00:00Z' }),
      link('off', STILL, { active: false }),
      link('nul', STILL, { active: null }), // mig 626: a NULL active is active
    ], error: null },
    staff_qualifications: { data: [RECORD], error: null },
    ...over,
  }))

  it('a manager gets every current member A–Z with their records; tombstoned and deactivated people are not listed', async () => {
    const db = pageDb()
    const out = await loadQualificationsPage(db, { user: manager, locationId: STILL, today: '2026-09-28' })
    expect(out.status).toBe(200)
    expect(out.body.data).toMatchObject({ audience: 'manager', today: '2026-09-28', organization_id: ORG, can_edit_types: false, types: TYPES })
    expect(out.body.data.people).toEqual([
      { profile_id: 'ann', full_name: 'Ann', records: [RECORD] },
      { profile_id: 'bob', full_name: 'Bob', records: [] },
      { profile_id: 'nul', full_name: 'Nul', records: [] },
    ])
    const recQ = db.log.find((q) => q.table === 'staff_qualifications')
    expect(filter(recQ, 'eq', 'organization_id')).toBe(ORG)
    expect(filter(recQ, 'in', 'profile_id')).toEqual(['ann', 'bob', 'nul'])
    const memberQ = db.log.find((q) => q.table === 'profile_locations')
    expect(filter(memberQ, 'eq', 'location_id')).toBe(STILL)
  })

  it('an owner may also edit the catalogue', async () => {
    const out = await loadQualificationsPage(pageDb(), { user: owner, locationId: STILL, today: '2026-09-28' })
    expect(out.body.data.can_edit_types).toBe(true)
  })

  it.each([['a coach', coach], ['a head coach', headCoach]])('%s gets their own records only, read-only', async (_, user) => {
    const own = { ...RECORD, profile_id: user.id }
    const db = pageDb({ staff_qualifications: { data: [own], error: null } })
    const out = await loadQualificationsPage(db, { user, locationId: STILL, today: '2026-09-28' })
    expect(out.body.data).toMatchObject({ audience: 'self', can_edit_types: false })
    expect(out.body.data.people).toEqual([{ profile_id: user.id, full_name: user.full_name, records: [own] }])
    expect(db.log.some((q) => q.table === 'profile_locations')).toBe(false)
    expect(filter(db.log.find((q) => q.table === 'staff_qualifications'), 'in', 'profile_id')).toEqual([user.id])
  })

  it('a failed read is a 500, never an empty list; a studio that does not exist is a 404', async () => {
    for (const table of ['staff_qualification_types', 'profile_locations', 'staff_qualifications']) {
      const out = await loadQualificationsPage(pageDb({ [table]: { data: null, error: { message: 'down' } } }), { user: manager, locationId: STILL, today: '2026-09-28' })
      expect(out.status, table).toBe(500)
    }
    const missing = await loadQualificationsPage(pageDb({ locations: { data: null, error: null } }), { user: manager, locationId: STILL, today: '2026-09-28' })
    expect(missing.status).toBe(404)
  })
})

describe('createQualificationRecord', () => {
  const INPUT = { profile_id: 'ann', qualification_type_id: 'fa', expires_on: '2027-01-01', note: '  PHECC  ' }
  const createDb = ({ type = TYPES[0], links = [link('ann', STILL)], insert } = {}) => mockDb(byTable({
    'staff_qualification_types.select': { data: type, error: null },
    'profile_locations.select': { data: links, error: null },
    'staff_qualifications.insert': insert ?? ((q) => ({ data: { id: 'new', ...q.payload }, error: null })),
  }))

  it('records it in the TYPE\'s organisation, trims the note, stamps who recorded it', async () => {
    const db = createDb()
    const out = await createQualificationRecord(db, { user: manager, input: INPUT })
    expect(out.status).toBe(201)
    const ins = db.log.find((q) => q.op === 'insert')
    expect(ins.payload).toEqual({
      organization_id: ORG, profile_id: 'ann', qualification_type_id: 'fa',
      issued_on: null, expires_on: '2027-01-01', note: 'PHECC', recorded_by: 'm1', updated_by: 'm1',
    })
    expect(filter(db.log.find((q) => q.table === 'profile_locations'), 'eq', 'profile_id')).toBe('ann')
  })

  it('a blank note is stored as null', async () => {
    const db = createDb()
    await createQualificationRecord(db, { user: manager, input: { ...INPUT, note: ' \n ' } })
    expect(db.log.find((q) => q.op === 'insert').payload.note).toBeNull()
  })

  it.each([
    ['an unknown type', { type: null }, manager],
    ['a person at a studio the caller does not manage', { links: [link('ann', HATCH)] }, manager],
    ['a head coach (not a records role)', {}, headCoach],
    ['a coach', {}, coach],
    ['a deactivated person', { links: [link('ann', STILL, { active: false })] }, manager],
    ['a tombstone', { links: [link('ann', STILL, { active: false, deleted_at: '2026-09-01T00:00:00Z' })] }, manager],
    ['a person only at another organisation\'s studio', { links: [link('ann', GARAGE)] }, owner],
  ])('404 for %s, and nothing is written', async (_, over, user) => {
    const db = createDb(over)
    const out = await createQualificationRecord(db, { user, input: INPUT })
    expect(out.status).toBe(404)
    expect(db.log.some((q) => q.op === 'insert')).toBe(false)
  })

  it('a master may record for anyone at a studio of the type\'s organisation', async () => {
    const out = await createQualificationRecord(createDb(), { user: master, input: INPUT })
    expect(out.status).toBe(201)
  })

  it('an archived type is refused (400) once the caller is known to be allowed', async () => {
    const out = await createQualificationRecord(createDb({ type: TYPES[1] }), { user: manager, input: { ...INPUT, qualification_type_id: 'old' } })
    expect(out).toMatchObject({ status: 400, body: { success: false, error: expect.stringMatching(/archived/) } })
  })

  it('a duplicate is a 409; a CHECK refusal is a 400; anything else is a 500', async () => {
    const dup = await createQualificationRecord(createDb({ insert: { data: null, error: { code: '23505', message: 'dup' } } }), { user: manager, input: INPUT })
    expect(dup.status).toBe(409)
    const chk = await createQualificationRecord(createDb({ insert: { data: null, error: { code: '23514', message: 'check' } } }), { user: manager, input: INPUT })
    expect(chk.status).toBe(400)
    const boom = await createQualificationRecord(createDb({ insert: { data: null, error: { code: 'XX000', message: 'boom' } } }), { user: manager, input: INPUT })
    expect(boom.status).toBe(500)
  })

  // QUALS.1 review 5 — a CHECK refusal names what broke it, from the constraint.
  it.each([
    ['staff_qualifications_dates', /expiry date is before the issue date/],
    ['staff_qualifications_note', /note is at most 300 characters/],
  ])('a %s refusal says so', async (constraint, words) => {
    const msg = `new row for relation "staff_qualifications" violates check constraint "${constraint}"`
    const out = await createQualificationRecord(createDb({ insert: { data: null, error: { code: '23514', message: msg } } }), { user: manager, input: INPUT })
    expect(out).toMatchObject({ status: 400, body: { error: expect.stringMatching(words) } })
  })
})

describe('updateQualificationRecord and deleteQualificationRecord', () => {
  const rowDb = ({ record = RECORD, links = [link('ann', STILL)], write } = {}) => mockDb(byTable({
    'staff_qualifications.select': { data: record, error: null },
    'profile_locations.select': { data: links, error: null },
    'staff_qualifications.update': write ?? ((q) => ({ data: [{ ...RECORD, ...q.payload }], error: null })),
    'staff_qualifications.delete': write ?? { data: [{ id: 'r1' }], error: null },
  }))

  it('updates only the fields sent, stamps updated_by/updated_at, scoped to the record\'s organisation', async () => {
    const db = rowDb()
    const out = await updateQualificationRecord(db, { user: manager, id: 'r1', input: { expires_on: '2028-05-01' } })
    expect(out.status).toBe(200)
    const upd = db.log.find((q) => q.op === 'update')
    expect(Object.keys(upd.payload).sort()).toEqual(['expires_on', 'updated_at', 'updated_by'])
    expect(upd.payload.updated_by).toBe('m1')
    expect(filter(upd, 'eq', 'id')).toBe('r1')
    expect(filter(upd, 'eq', 'organization_id')).toBe(ORG)
  })

  it('judges the dates against what is stored: a new expiry before the stored issue date is a 400, nothing written', async () => {
    const db = rowDb()
    const out = await updateQualificationRecord(db, { user: manager, id: 'r1', input: { expires_on: '2026-04-01' } })
    expect(out.status).toBe(400)
    expect(db.log.some((q) => q.op === 'update')).toBe(false)
  })

  it('404: a missing record, one the caller does not manage, a zero-row write', async () => {
    expect((await updateQualificationRecord(rowDb({ record: null }), { user: manager, id: 'r1', input: { note: 'x' } })).status).toBe(404)
    expect((await updateQualificationRecord(rowDb({ links: [link('ann', HATCH)] }), { user: manager, id: 'r1', input: { note: 'x' } })).status).toBe(404)
    expect((await updateQualificationRecord(rowDb({ write: { data: [], error: null } }), { user: manager, id: 'r1', input: { note: 'x' } })).status).toBe(404)
    expect((await deleteQualificationRecord(rowDb({ links: [link('ann', HATCH)] }), { user: manager, id: 'r1' })).status).toBe(404)
    expect((await deleteQualificationRecord(rowDb({ write: { data: [], error: null } }), { user: manager, id: 'r1' })).status).toBe(404)
  })

  it('deletes, scoped to the record\'s organisation', async () => {
    const db = rowDb()
    const out = await deleteQualificationRecord(db, { user: owner, id: 'r1' })
    expect(out).toEqual({ status: 200, body: { success: true, data: { id: 'r1', deleted: true } } })
    const del = db.log.find((q) => q.op === 'delete')
    expect(filter(del, 'eq', 'organization_id')).toBe(ORG)
  })
})

describe('the catalogue', () => {
  it('canEditCatalogue: an owner at a studio of that organisation, or a master', () => {
    expect(canEditCatalogue(owner, ORG)).toBe(true)
    expect(canEditCatalogue(owner, OTHER_ORG)).toBe(false)
    expect(canEditCatalogue(manager, ORG)).toBe(false)
    expect(canEditCatalogue(master, OTHER_ORG)).toBe(true)
    expect(canEditCatalogue(null, ORG)).toBe(false)
  })

  it('creates a type in the studio\'s organisation; a duplicate name is a 409', async () => {
    const db = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      'staff_qualification_types.insert': (q) => ({ data: { id: 'new', ...q.payload, active: true, sort_order: 100 }, error: null }),
    }))
    const out = await createQualificationType(db, { user: owner, input: { location_id: STILL, name: 'Manual handling' } })
    expect(out.status).toBe(201)
    expect(db.log.find((q) => q.op === 'insert').payload).toEqual({ organization_id: ORG, name: 'Manual handling', created_by: 'o1' })
    const dupDb = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      'staff_qualification_types.insert': { data: null, error: { code: '23505', message: 'dup' } },
    }))
    expect((await createQualificationType(dupDb, { user: owner, input: { location_id: STILL, name: 'First aid' } })).status).toBe(409)
  })

  it('a type-name CHECK refusal talks about the name, never dates or notes (review 5)', async () => {
    const db = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      'staff_qualification_types.insert': { data: null, error: { code: '23514', message: 'new row for relation "staff_qualification_types" violates check constraint "staff_qualification_types_name"' } },
    }))
    const out = await createQualificationType(db, { user: owner, input: { location_id: STILL, name: 'X' } })
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/name/i)
    expect(out.body.error).not.toMatch(/date|note/i)
  })

  it('renames or archives a type for an owner of its organisation; 404 for anyone else', async () => {
    const typeDb = () => mockDb(byTable({
      'staff_qualification_types.select': { data: TYPES[0], error: null },
      'staff_qualification_types.update': (q) => ({ data: [{ ...TYPES[0], ...q.payload }], error: null }),
    }))
    const db = typeDb()
    const out = await updateQualificationType(db, { user: owner, id: 'fa', input: { active: false } })
    expect(out.status).toBe(200)
    const upd = db.log.find((q) => q.op === 'update')
    expect(upd.payload).toEqual({ active: false })
    expect(filter(upd, 'eq', 'organization_id')).toBe(ORG)
    const refused = typeDb()
    expect((await updateQualificationType(refused, { user: manager, id: 'fa', input: { name: 'X' } })).status).toBe(404)
    expect(refused.log.some((q) => q.op === 'update')).toBe(false)
  })
})

describe('template requirements', () => {
  it('reads the studio\'s catalogue and every template\'s requirements, keyed by template', async () => {
    const db = mockDb(byTable({
      locations: { data: { id: STILL, organization_id: ORG }, error: null },
      staff_qualification_types: { data: TYPES, error: null },
      shift_templates: { data: [{ id: 't1' }, { id: 't2' }], error: null },
      shift_template_qualification_requirements: { data: [{ template_id: 't1', qualification_type_id: 'fa' }], error: null },
    }))
    const out = await readTemplateRequirements(db, { locationId: STILL })
    expect(out).toEqual({ status: 200, body: { success: true, data: { types: TYPES, requirements: { t1: ['fa'] } } } })
    expect(filter(db.log.find((q) => q.table === 'shift_templates'), 'eq', 'location_id')).toBe(STILL)
    expect(filter(db.log.find((q) => q.table === 'shift_template_qualification_requirements'), 'in', 'template_id')).toEqual(['t1', 't2'])
  })

  const TYPES_WITH_INS = [...TYPES, { id: 'ins', organization_id: ORG, name: 'Insurance', active: true, sort_order: 20 }]
  const reqDb = ({ template = { id: 't1', location_id: STILL }, current = ['fa'], types = TYPES_WITH_INS, add } = {}) => mockDb(byTable({
    shift_templates: { data: template, error: null },
    locations: { data: { id: STILL, organization_id: ORG }, error: null },
    'shift_template_qualification_requirements.select': { data: current.map((id) => ({ qualification_type_id: id })), error: null },
    'staff_qualification_types.select': (q) => ({ data: types.filter((t) => filter(q, 'in', 'id').includes(t.id)), error: null }),
    'shift_template_qualification_requirements.delete': { data: null, error: null },
    'shift_template_qualification_requirements.upsert': add ?? { data: null, error: null },
  }))

  it('replaces the set: removes what was dropped, adds what is new, ignores duplicates', async () => {
    const db = reqDb()
    const out = await replaceTemplateRequirements(db, { user: headCoach, input: { template_id: 't1', qualification_type_ids: ['ins', 'ins'] } })
    expect(out.body.data).toEqual({ template_id: 't1', qualification_type_ids: ['ins'], added: 1, removed: 1 })
    const del = db.log.find((q) => q.op === 'delete')
    expect(filter(del, 'eq', 'template_id')).toBe('t1')
    expect(filter(del, 'in', 'qualification_type_id')).toEqual(['fa'])
    const up = db.log.find((q) => q.op === 'upsert')
    expect(up.payload).toEqual([{ template_id: 't1', qualification_type_id: 'ins', created_by: 'h1' }])
    expect(up.options).toEqual({ onConflict: 'template_id,qualification_type_id', ignoreDuplicates: true })
  })

  it('no change, no write', async () => {
    const db = reqDb()
    await replaceTemplateRequirements(db, { user: manager, input: { template_id: 't1', qualification_type_ids: ['fa'] } })
    expect(db.log.some((q) => q.op === 'delete' || q.op === 'upsert')).toBe(false)
  })

  it('refuses a type from another organisation (400) and a newly added archived type (400); an archived type already required may stay', async () => {
    const foreign = await replaceTemplateRequirements(reqDb({ types: [{ id: 'zz', organization_id: OTHER_ORG, name: 'X', active: true }] }),
      { user: manager, input: { template_id: 't1', qualification_type_ids: ['zz'] } })
    expect(foreign.status).toBe(400)
    const archivedNew = await replaceTemplateRequirements(reqDb(), { user: manager, input: { template_id: 't1', qualification_type_ids: ['old'] } })
    expect(archivedNew.status).toBe(400)
    const archivedKept = await replaceTemplateRequirements(reqDb({ current: ['old'] }), { user: manager, input: { template_id: 't1', qualification_type_ids: ['old'] } })
    expect(archivedKept.status).toBe(200)
  })

  it('404 for a template that does not exist or is at a studio the caller is not in; 403 for staff at the studio', async () => {
    expect((await replaceTemplateRequirements(reqDb({ template: null }), { user: manager, input: { template_id: 't1', qualification_type_ids: [] } })).status).toBe(404)
    expect((await replaceTemplateRequirements(reqDb({ template: { id: 't9', location_id: HATCH } }), { user: manager, input: { template_id: 't9', qualification_type_ids: [] } })).status).toBe(404)
    expect((await replaceTemplateRequirements(reqDb(), { user: coach, input: { template_id: 't1', qualification_type_ids: [] } })).status).toBe(403)
  })

  it('the database\'s same-organisation refusal is a 400, not a 500', async () => {
    const out = await replaceTemplateRequirements(reqDb({ add: { data: null, error: { code: 'P0001', message: 'qualification_requirement_other_org: type x' } } }),
      { user: manager, input: { template_id: 't1', qualification_type_ids: ['fa', 'ins'] } })
    expect(out.status).toBe(400)
  })
})

describe('readBlockQualificationFacts (the ranked picker\'s read)', () => {
  it('no template, nothing read', async () => {
    const db = mockDb()
    expect(await readBlockQualificationFacts(db, { templateId: null, profileIds: ['a'] })).toEqual({ required: [], records: [], error: null })
    expect(db.log).toHaveLength(0)
  })

  it('reads the ACTIVE required types, then only those types\' records for these people', async () => {
    const db = mockDb(byTable({
      shift_template_qualification_requirements: { data: [
        { qualification_type_id: 'fa', staff_qualification_types: TYPES[0] },
        { qualification_type_id: 'old', staff_qualification_types: TYPES[1] },
      ], error: null },
      staff_qualifications: { data: [{ profile_id: 'a', qualification_type_id: 'fa', expires_on: '2027-01-01' }], error: null },
    }))
    const out = await readBlockQualificationFacts(db, { templateId: 't1', profileIds: ['a', 'b', 'a'] })
    expect(out.required).toEqual([{ id: 'fa', name: 'First aid', organization_id: ORG }])
    expect(out.records).toHaveLength(1)
    const recQ = db.log.find((q) => q.table === 'staff_qualifications')
    expect(filter(recQ, 'eq', 'organization_id')).toBe(ORG)
    expect(filter(recQ, 'in', 'qualification_type_id')).toEqual(['fa'])
    expect(filter(recQ, 'in', 'profile_id')).toEqual(['a', 'b'])
  })

  it('a template that requires nothing (or only archived types) reads no records', async () => {
    const db = mockDb(byTable({ shift_template_qualification_requirements: { data: [{ qualification_type_id: 'old', staff_qualification_types: TYPES[1] }], error: null } }))
    expect(await readBlockQualificationFacts(db, { templateId: 't1', profileIds: ['a'] })).toEqual({ required: [], records: [], error: null })
    expect(db.log.some((q) => q.table === 'staff_qualifications')).toBe(false)
  })

  it('a failed read is an error (the picker says "not checked"), never "nothing required"', async () => {
    const db = mockDb(byTable({ shift_template_qualification_requirements: { data: null, error: { message: 'down' } } }))
    expect(await readBlockQualificationFacts(db, { templateId: 't1', profileIds: ['a'] })).toEqual({ required: null, records: null, error: { message: 'down' } })
  })
})
