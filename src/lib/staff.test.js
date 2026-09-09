import { describe, it, expect, vi } from 'vitest'
import { listStaffForUser, getStaffForUser, STAFF_PUBLIC_FIELDS } from './staff.js'

function mockDb({ links = [], profiles = [], detailLinks = null } = {}) {
  const calls = { profilesSelect: null, linkLocationIds: null }
  return {
    calls,
    from(table) {
      if (table === 'profile_locations') {
        return {
          select: () => ({
            in: (_col, ids) => {
              calls.linkLocationIds = ids
              return Promise.resolve({ data: links, error: null })
            },
            eq: () => ({ in: () => ({ limit: () => Promise.resolve({ data: detailLinks ?? links, error: null }) }) }),
          }),
        }
      }
      if (table === 'profiles') {
        return {
          select: (clause) => {
            calls.profilesSelect = clause
            return {
              in: () => ({ order: () => Promise.resolve({ data: profiles, error: null }) }),
              eq: () => ({ single: () => Promise.resolve({ data: profiles[0] ?? null, error: profiles[0] ? null : { message: 'no rows' } }) }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

const adminUser = { role: 'owner', locations: [{ id: 'loc-1' }] }
const staffUser = { role: 'staff', locations: [{ id: 'loc-1' }] }

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
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: adminUser })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).toContain('*')
    expect(db.calls.profilesSelect).not.toContain(STAFF_PUBLIC_FIELDS)
  })
  it('non-admins get the slim public field list (no salary)', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
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
    const db = mockDb({ detailLinks: [{ profile_id: 'p1' }], profiles: [{ id: 'p1', full_name: 'Ada' }] })
    const res = await getStaffForUser({ db, user: adminUser, id: 'p1' })
    expect(res.ok).toBe(true)
    expect(res.data.full_name).toBe('Ada')
  })
  it('non-admin gets the slim select for the detail too', async () => {
    const db = mockDb({ detailLinks: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    await getStaffForUser({ db, user: staffUser, id: 'p1' })
    expect(db.calls.profilesSelect).toContain(STAFF_PUBLIC_FIELDS)
  })
})

// ROSTER-FIX.2 — the roster coach picker used to fetch /api/staff, which
// hands an admin caller `*` — every pay column — to build a name dropdown.
describe('listStaffForUser — picker shape', () => {
  it('never selects pay columns, even for a master caller', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    const res = await listStaffForUser({ db, user: { role: 'master', locations: [{ id: 'loc-1' }] }, fields: 'picker' })
    expect(res.ok).toBe(true)
    expect(db.calls.profilesSelect).not.toContain('*')
    expect(db.calls.profilesSelect).not.toContain('hourly_rate')
    expect(db.calls.profilesSelect).not.toContain('annual_salary')
    // ROSTER-FIX.6c — overtime_rate was the one pay column this pin missed.
    expect(db.calls.profilesSelect).not.toContain('overtime_rate')
    expect(db.calls.profilesSelect).toContain('full_name')
  })

  // ROSTER-FIX.6c — the schedule calendar loads this shape now, so the picker
  // has to carry everything the roster screen reads off a coach: the assign
  // modal (name, role, active, location links) and the FTE utilisation bars
  // (employment_type + contracted_hours_per_week, neither of which is a rate).
  it('carries every column the roster screen reads off a coach', async () => {
    const db = mockDb({ links: [{ profile_id: 'p1' }], profiles: [{ id: 'p1' }] })
    await listStaffForUser({ db, user: { role: 'master', locations: [{ id: 'loc-1' }] }, fields: 'picker' })
    for (const col of ['id', 'full_name', 'active', 'role', 'avatar_url', 'employment_type', 'contracted_hours_per_week']) {
      expect(db.calls.profilesSelect).toContain(col)
    }
    expect(db.calls.profilesSelect).toContain('profile_locations(location_id')
  })
})

// ROSTER-FIX.6c — the caller can now ask for ONE of their locations. The
// colleague picker on a Stillorgan shift must not offer Hatch Street's coaches
// as swap partners, and the link query is where that is decided: narrow the set
// of locations whose profiles are gathered, rather than gathering both and
// trimming afterwards.
describe('listStaffForUser — one location', () => {
  const twoStudios = { role: 'manager', locations: [{ id: 'loc-1' }, { id: 'loc-2' }] }

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
