import { describe, it, expect, vi } from 'vitest'
import { listStaffForUser, getStaffForUser, STAFF_PUBLIC_FIELDS } from './staff.js'

function mockDb({ links = [], profiles = [], detailLinks = null } = {}) {
  const calls = { profilesSelect: null }
  return {
    calls,
    from(table) {
      if (table === 'profile_locations') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: links, error: null }),
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
