import { describe, it, expect } from 'vitest'
import { listStaffForUser, getStaffForUser, STAFF_PUBLIC_FIELDS, STAFF_PICKER_FIELDS } from './staff.js'

function mockDb({ links = [], profiles = [], detailLinks = null } = {}) {
  const calls = { profilesSelect: null, linkLocationIds: null, linkSelect: null }
  // A link with no location_id (the older fixtures) is kept by any filter.
  const inScope = (rows, ids) => rows.filter((l) => !l.location_id || ids.includes(l.location_id))
  return {
    calls,
    from(table) {
      if (table === 'profile_locations') {
        return {
          select: (clause) => {
            calls.linkSelect = clause
            return {
              in: (_col, ids) => {
                calls.linkLocationIds = ids
                return Promise.resolve({ data: inScope(links, ids), error: null })
              },
              eq: () => ({ in: (_c, ids) => Promise.resolve({ data: inScope(detailLinks ?? links, ids), error: null }) }),
            }
          },
        }
      }
      if (table === 'profiles') {
        return {
          select: (clause) => {
            calls.profilesSelect = clause
            return {
              // The fake returns WHOLE rows whatever the select says, so a
              // test also proves the projection strips what must not leave.
              in: (_col, ids) => ({ order: () => Promise.resolve({ data: profiles.filter((p) => ids.includes(p.id)), error: null }) }),
              eq: () => ({ single: () => Promise.resolve({ data: profiles[0] ?? null, error: profiles[0] ? null : { message: 'no rows' } }) }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const adminUser = { id: 'me', role: 'owner', profileRole: 'owner', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'owner' } }
const staffUser = { id: 'me', role: 'staff', profileRole: 'staff', locations: [{ id: 'loc-1' }], rolesByLocation: { 'loc-1': 'staff' } }

describe('listStaffForUser', () => {
  it('returns [] when the caller has no locations', async () => {
    const res = await listStaffForUser({ db: mockDb(), user: { role: 'staff', locations: [] } })
    expect(res).toEqual({ ok: true, data: [] })
  })
  it('returns [] when no profiles share a location', async () => {
    const res = await listStaffForUser({ db: mockDb({ links: [] }), user: adminUser })
    expect(res).toEqual({ ok: true, data: [] })
  })
  it('admins get the full select (HR fields)', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1', location_id: 'loc-1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: adminUser })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).toContain('*')
    expect(db.calls.profilesSelect).not.toContain(STAFF_PUBLIC_FIELDS)
  })
  it('non-admins get the slim public field list (no salary)', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1', location_id: 'loc-1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: staffUser })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).toContain(STAFF_PUBLIC_FIELDS)
    expect(db.calls.profilesSelect).not.toContain('hourly_rate')
  })
})

describe('getStaffForUser', () => {
  it('404 when the caller has no locations', async () => {
    const res = await getStaffForUser({ db: mockDb(), user: { role: 'owner', locations: [] }, id: 'p1' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
  it('404 when the target shares no location with the caller (cross-tenant)', async () => {
    const db = mockDb({ detailLinks: [] })
    const res = await getStaffForUser({ db, user: adminUser, id: 'p-other' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
  it('returns the profile when the target shares a location', async () => {
    const db = mockDb({ detailLinks: [{ location_id: 'loc-1' }], profiles: [{ id: 'p1', full_name: 'Ada' }] })
    const res = await getStaffForUser({ db, user: adminUser, id: 'p1' })
    expect(res.ok).toBe(true)
    expect(res.data.full_name).toBe('Ada')
  })
  it('non-admin gets the slim select for the detail too', async () => {
    const db = mockDb({ detailLinks: [{ location_id: 'loc-1' }], profiles: [{ id: 'p1' }] })
    await getStaffForUser({ db, user: staffUser, id: 'p1' })
    expect(db.calls.profilesSelect).toContain(STAFF_PUBLIC_FIELDS)
  })
})

// ROSTER-FIX.2 — the roster coach picker used to fetch /api/staff, which
// hands an admin caller `*` — every pay column — to build a name dropdown.
describe('listStaffForUser — picker shape', () => {
  it('never selects pay columns, even for a master caller', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }], rolesByLocation: {} }, fields: 'picker' })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).not.toContain('*')
    expect(db.calls.profilesSelect).not.toContain('hourly_rate')
    expect(db.calls.profilesSelect).not.toContain('annual_salary')
    // ROSTER-FIX.6c — overtime_rate was the one pay column this pin missed.
    expect(db.calls.profilesSelect).not.toContain('overtime_rate')
    expect(db.calls.profilesSelect).toContain('full_name')
  })

  // The roster screen reads name, role, active, avatar, employment type and the
  // location links off a coach. The contract is NOT in the shape (CONTRACTVIS.1):
  // it arrives only through include=contract, per row (below).
  it('carries every column the roster screen reads off a coach, and no contract', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1', location_id: 'loc-1' }], profiles: [{ id: 'p1' }] })
    await listStaffForUser({ db, user: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: 'loc-1' }], rolesByLocation: {} }, fields: 'picker' })
    for (const col of ['id', 'full_name', 'active', 'role', 'avatar_url', 'employment_type']) {
      expect(db.calls.profilesSelect).toContain(col)
    }
    expect(db.calls.profilesSelect).not.toContain('contracted_hours_per_week')
    expect(db.calls.profilesSelect).toContain('profile_locations(location_id')
  })
})

// ROSTER-FIX.6c — the caller can now ask for ONE of their locations. The
// colleague picker on a Stillorgan shift must not offer Hatch Street's coaches
// as swap partners, and the link query is where that is decided: narrow the set
// of locations whose profiles are gathered, rather than gathering both and
// trimming afterwards.
describe('listStaffForUser — one location', () => {
  const twoStudios = { id: 'me', role: 'manager', profileRole: 'manager', locations: [{ id: 'loc-1' }, { id: 'loc-2' }], rolesByLocation: { 'loc-1': 'manager', 'loc-2': 'manager' } }

  it('gathers profiles from the asked-for location only', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: twoStudios, locationId: 'loc-2' })
    expect(res.ok).toBe(true)
    expect(db.calls.linkLocationIds).toEqual(['loc-2'])
  })

  it('is unchanged without the argument: every location the caller holds', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    await listStaffForUser({ db, user: twoStudios })
    expect(db.calls.linkLocationIds).toEqual(['loc-1', 'loc-2'])
  })

  it('returns nothing for a location the caller does not hold, without querying', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: twoStudios, locationId: 'loc-9' })
    expect(res).toEqual({ ok: true, data: [] })
    expect(db.calls.linkLocationIds).toBeNull()
  })
})

// CONTRACTVIS.1 (Richard, 27 Sep) — a colleague's contracted hours go to
// owner / manager / master at their studio only. The two shapes every other
// caller receives never carry the column, or any pay column.
describe('CONTRACTVIS.1 — the slim shapes', () => {
  const BANNED = ['contracted_hours_per_week', 'annual_salary', 'hourly_rate', 'overtime_rate', 'annual_leave_entitlement']
  for (const [name, fields] of [['STAFF_PUBLIC_FIELDS', STAFF_PUBLIC_FIELDS], ['STAFF_PICKER_FIELDS', STAFF_PICKER_FIELDS]]) {
    it(`${name} carries no contract and no pay column`, () => {
      const cols = fields.split(',').map((c) => c.trim())
      for (const banned of BANNED) expect(cols).not.toContain(banned)
    })
  }
})

// CONTRACTVIS.1 — who receives a colleague's contract (and, on the full shape,
// the HR columns). Four people: pA works only at A, pB only at B, pAB at both,
// and `me` (the caller) at both. The fake returns every column on every row, so
// what comes OUT is the projection's answer.
describe('CONTRACTVIS.1 — listStaffForUser, per row', () => {
  const A = 'loc-a'
  const B = 'loc-b'
  const person = (id) => ({
    id, full_name: `Coach ${id}`, email: `${id}@example.com`, role: 'staff', avatar_url: null,
    active: true, employment_type: 'fte', contracted_hours_per_week: 39,
    annual_salary: 40000, hourly_rate: null, overtime_rate: null,
    profile_locations: [{ location_id: A, role: 'staff', permissions: {}, locations: { id: A, name: 'A', slug: 'a', address: 'x' } }],
  })
  const PROFILES = ['me', 'pA', 'pAB', 'pB'].map(person)
  const LINKS = [
    { profile_id: 'pA', location_id: A },
    { profile_id: 'pB', location_id: B },
    { profile_id: 'pAB', location_id: A }, { profile_id: 'pAB', location_id: B },
    { profile_id: 'me', location_id: A }, { profile_id: 'me', location_id: B },
  ]
  const caller = (rolesByLocation, { active = A, profileRole = 'staff' } = {}) => ({
    id: 'me', role: rolesByLocation[active] || profileRole, profileRole,
    locations: [{ id: A }, { id: B }], rolesByLocation, activeLocation: { id: active },
  })
  const CALLERS = {
    owner: caller({ [A]: 'owner', [B]: 'owner' }, { profileRole: 'owner' }),
    manager: caller({ [A]: 'manager', [B]: 'manager' }, { profileRole: 'manager' }),
    master: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: A }, { id: B }], rolesByLocation: {} },
    head_coach: caller({ [A]: 'head_coach', [B]: 'head_coach' }),
    staff: caller({ [A]: 'staff', [B]: 'staff' }),
    'manager at A, head coach at B (A active)': caller({ [A]: 'manager', [B]: 'head_coach' }, { active: A, profileRole: 'manager' }),
    'manager at A, head coach at B (B active)': caller({ [A]: 'manager', [B]: 'head_coach' }, { active: B, profileRole: 'manager' }),
  }
  const withKey = (rows, key) => rows.filter((r) => Object.prototype.hasOwnProperty.call(r, key)).map((r) => r.id).sort()
  const run = async (user, args = {}) => {
    const db = mockDb({ links: LINKS, profiles: PROFILES })
    const res = await listStaffForUser({ db, user, ...args })
    expect(res.ok).toBe(true)
    return { rows: res.data, select: db.calls.profilesSelect, linkSelect: db.calls.linkSelect }
  }

  const PICKER_CONTRACT = {
    owner: ['me', 'pA', 'pAB', 'pB'],
    manager: ['me', 'pA', 'pAB', 'pB'],
    master: ['me', 'pA', 'pAB', 'pB'],
    head_coach: ['me'],
    staff: ['me'],
    'manager at A, head coach at B (A active)': ['me', 'pA', 'pAB'],
    'manager at A, head coach at B (B active)': ['me', 'pA', 'pAB'],
  }
  for (const [label, expected] of Object.entries(PICKER_CONTRACT)) {
    it(`picker + include=contract, ${label}: contract on ${expected.join(', ')} only`, async () => {
      const { rows } = await run(CALLERS[label], { fields: 'picker', includeContract: true })
      expect(withKey(rows, 'contracted_hours_per_week')).toEqual(expected)
      expect(withKey(rows, 'annual_salary')).toEqual([])
    })
  }

  it('picker without include=contract: nobody carries it, the caller included, and it is not read', async () => {
    const { rows, select } = await run(CALLERS.owner, { fields: 'picker' })
    expect(withKey(rows, 'contracted_hours_per_week')).toEqual([])
    expect(select).not.toContain('contracted_hours_per_week')
  })

  it('a head coach asking for contracts in a list without their own row: the column is not even read', async () => {
    const db = mockDb({ links: LINKS.filter((l) => l.profile_id !== 'me'), profiles: PROFILES.filter((p) => p.id !== 'me') })
    await listStaffForUser({ db, user: CALLERS.head_coach, fields: 'picker', includeContract: true })
    expect(db.calls.profilesSelect).not.toContain('contracted_hours_per_week')
  })

  const FULL_HR = {
    owner: ['me', 'pA', 'pAB', 'pB'],
    manager: ['me', 'pA', 'pAB', 'pB'],
    master: ['me', 'pA', 'pAB', 'pB'],
    head_coach: [],
    staff: [],
    'manager at A, head coach at B (A active)': ['me', 'pA', 'pAB'],
    'manager at A, head coach at B (B active)': ['me', 'pA', 'pAB'],
  }
  for (const [label, expected] of Object.entries(FULL_HR)) {
    it(`full shape, ${label}: HR columns on ${expected.join(', ') || 'nobody'}; contract on those plus their own row`, async () => {
      const { rows } = await run(CALLERS[label])
      expect(withKey(rows, 'annual_salary')).toEqual(expected)
      expect(withKey(rows, 'contracted_hours_per_week')).toEqual([...new Set([...expected, 'me'])].sort())
    })
  }

  it('a row the caller does not manage goes out as exactly the public keys plus trimmed links', async () => {
    const { rows } = await run(CALLERS.head_coach)
    const pB = rows.find((r) => r.id === 'pB')
    expect(Object.keys(pB).sort()).toEqual(
      ['active', 'avatar_url', 'email', 'employment_type', 'full_name', 'id', 'profile_locations', 'role'].sort(),
    )
    expect(pB.profile_locations).toEqual([{ location_id: A, role: 'staff', locations: { id: A, name: 'A', slug: 'a' } }])
  })

  it('a head coach everywhere never triggers the full select', async () => {
    const { select } = await run(CALLERS.head_coach)
    expect(select).not.toContain('*')
  })

  it('reads the link locations, which the per-row rule needs', async () => {
    const { linkSelect } = await run(CALLERS.owner)
    expect(linkSelect).toBe('profile_id, location_id')
  })

  it('location_id=B narrows the judgement to B: the mixed person manages nobody there', async () => {
    const { rows } = await run(CALLERS['manager at A, head coach at B (A active)'], { fields: 'picker', includeContract: true, locationId: B })
    // pA is not at B; pAB and pB are listed, and the caller manages neither AT B.
    expect(rows.map((r) => r.id).sort()).toEqual(['me', 'pAB', 'pB'])
    expect(withKey(rows, 'contracted_hours_per_week')).toEqual(['me'])
  })
})

describe('CONTRACTVIS.1 — getStaffForUser, per person', () => {
  const A = 'loc-a'
  const B = 'loc-b'
  const target = (id) => ({ id, full_name: `Coach ${id}`, email: `${id}@example.com`, role: 'staff', avatar_url: null, active: true, employment_type: 'fte', contracted_hours_per_week: 39, annual_salary: 40000, profile_locations: [] })
  const mixed = { id: 'me', role: 'manager', profileRole: 'manager', locations: [{ id: A }, { id: B }], rolesByLocation: { [A]: 'manager', [B]: 'head_coach' } }
  const coach = { id: 'me', role: 'head_coach', profileRole: 'head_coach', locations: [{ id: A }], rolesByLocation: { [A]: 'head_coach' } }

  it('manager at A reading someone only at B (where they are head coach): public shape, no contract', async () => {
    const db = mockDb({ detailLinks: [{ location_id: B }], profiles: [target('pB')] })
    const res = await getStaffForUser({ db, user: mixed, id: 'pB' })
    expect(res.ok).toBe(true)
    expect(res.data).not.toHaveProperty('annual_salary')
    expect(res.data).not.toHaveProperty('contracted_hours_per_week')
    expect(res.data).not.toHaveProperty('role_templates')
    expect(db.calls.profilesSelect).not.toContain('*')
  })

  it('manager at A reading someone at A: the full profile with role templates', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }], profiles: [target('pA')] })
    const res = await getStaffForUser({ db, user: mixed, id: 'pA' })
    expect(db.calls.profilesSelect).toContain('*')
    expect(res.data.contracted_hours_per_week).toBe(39)
    expect(res.data).toHaveProperty('role_templates')
  })

  it('manager at A with B active still manages people at A (the studio decides, not the active role)', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }, { location_id: B }], profiles: [target('pAB')] })
    const res = await getStaffForUser({ db, user: { ...mixed, role: 'head_coach', activeLocation: { id: B } }, id: 'pAB' })
    expect(res.data.contracted_hours_per_week).toBe(39)
  })

  it('a head coach reading a colleague: no contract', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }], profiles: [target('pA')] })
    const res = await getStaffForUser({ db, user: coach, id: 'pA' })
    expect(res.data).not.toHaveProperty('contracted_hours_per_week')
  })

  it('a head coach reading THEMSELVES keeps their own contract, and no pay column', async () => {
    const db = mockDb({ detailLinks: [{ location_id: A }], profiles: [target('me')] })
    const res = await getStaffForUser({ db, user: coach, id: 'me' })
    expect(res.data.contracted_hours_per_week).toBe(39)
    expect(res.data).not.toHaveProperty('annual_salary')
  })

  it('master: the full profile', async () => {
    const db = mockDb({ detailLinks: [{ location_id: B }], profiles: [target('pB')] })
    const res = await getStaffForUser({ db, user: { id: 'me', role: 'master', profileRole: 'master', locations: [{ id: A }, { id: B }], rolesByLocation: {} }, id: 'pB' })
    expect(res.data.annual_salary).toBe(40000)
  })
})
