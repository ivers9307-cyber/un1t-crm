// STAFF-LIST-SCOPE.1 — the roster shows the people you work with, and
// nothing on it may carry pay.
//
// Two defects, one page. It read `select('*')` on profiles and handed the
// rows to a CLIENT component: `profiles` still carries annual_salary,
// hourly_rate, contracted_hours_per_week, annual_leave_entitlement and
// overtime_rate, which mig 153 revoked from authenticated+anon precisely so
// a browser cannot read them ("only service_role can read"). This page reads
// with the service role, and `settings` is held by manager, owner AND
// master — so every manager received the whole estate's pay data. And the
// roster itself was every profile in the estate, another organisation's
// staff included.
//
// These tests assert the QUERY, because that is where both bugs live: the
// column list must not name a comp column, and the row set must be scoped.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import StaffIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_MINE = 'a0000000-0000-0000-0000-000000000001'
const LOC_THEIRS = 'b0000000-0000-0000-0000-000000000002'
const ME = 'u-me'
const PEER = 'u-peer'
const STRANGER = 'u-stranger'

const COMP_COLUMNS = [
  'annual_salary', 'hourly_rate', 'contracted_hours_per_week',
  'annual_leave_entitlement', 'overtime_rate',
]

function makeDb({ peersError = null } = {}) {
  const calls = []
  const from = (table) => {
    const q = { table, cols: null, inCol: null, inVals: null }
    calls.push(q)
    const chain = {
      select: (cols) => { q.cols = cols; return chain },
      in: (col, vals) => { q.inCol = col; q.inVals = vals; return chain },
      order: () => chain,
      then: (res) => {
        let data = []
        if (table === 'profile_locations') {
          if (peersError) return Promise.resolve({ data: null, error: peersError }).then(res)
          data = [{ profile_id: ME }, { profile_id: PEER }]
        } else if (table === 'profiles') {
          const rows = [
            { id: ME, full_name: 'Me', email: 'me@x.com', role: 'manager', active: true, profile_locations: [] },
            { id: PEER, full_name: 'Peer', email: 'peer@x.com', role: 'staff', active: true, profile_locations: [] },
            { id: STRANGER, full_name: 'Stranger', email: 's@x.com', role: 'staff', active: true, profile_locations: [] },
          ]
          data = q.inVals ? rows.filter(r => q.inVals.includes(r.id)) : rows
        }
        return Promise.resolve({ data, error: null }).then(res)
      },
    }
    return chain
  }
  return { calls, from }
}

const user = ({ isMaster = false, locations = [{ id: LOC_MINE }] }) => ({
  id: ME, role: isMaster ? 'master' : 'manager', isMaster,
  profileRole: isMaster ? 'master' : 'manager',
  locations, rolesByLocation: Object.fromEntries(locations.map(l => [l.id, 'manager'])),
  activeLocation: { id: LOC_MINE },
})

const rosterQuery = (db) => db.calls.find(c => c.table === 'profiles' && c.cols && c.cols.includes('full_name'))

describe('/settings/staff — roster scope and columns', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb()
    createServerClient.mockReturnValue(db)
  })

  it('never selects a compensation column — mig 153 revoked them from the browser', async () => {
    getCurrentUser.mockResolvedValue(user({}))
    await StaffIndexPage()
    for (const q of db.calls.filter(c => c.table === 'profiles')) {
      expect(q.cols).toBeTruthy()
      expect(q.cols).not.toBe('*')
      for (const col of COMP_COLUMNS) expect(q.cols).not.toContain(col)
    }
  })

  it('scopes the roster to profiles at the caller’s own locations', async () => {
    getCurrentUser.mockResolvedValue(user({}))
    await StaffIndexPage()
    const peers = db.calls.find(c => c.table === 'profile_locations')
    expect(peers.inCol).toBe('location_id')
    expect(peers.inVals).toEqual([LOC_MINE])
    const roster = rosterQuery(db)
    expect(roster.inCol).toBe('id')
    // The stranger at another org is not in the id set.
    expect(roster.inVals).toEqual([ME, PEER])
    expect(roster.inVals).not.toContain(STRANGER)
  })

  it('leaves a master unrestricted', async () => {
    getCurrentUser.mockResolvedValue(user({ isMaster: true }))
    await StaffIndexPage()
    expect(db.calls.find(c => c.table === 'profile_locations')).toBeUndefined()
    expect(rosterQuery(db).inVals).toBeNull()
  })

  it('still derives the app-version baseline estate-wide, from id/active only', async () => {
    getCurrentUser.mockResolvedValue(user({}))
    await StaffIndexPage()
    const baseline = db.calls.find(c => c.table === 'profiles' && c.cols === 'id, active')
    expect(baseline).toBeTruthy()
    // Unscoped on purpose: "is this phone behind?" is about releases.
    expect(baseline.inVals).toBeNull()
  })

  it('treats an unreadable peer list as refusal, never as "show everyone"', async () => {
    // Fail closed: a blip costs a manager a retry; failing open hands them
    // the estate.
    db = makeDb({ peersError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(user({}))

    await expect(StaffIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    expect(db.calls.filter(c => c.table === 'profiles')).toEqual([])
  })

  it('bounces a caller assigned to no location, before reading any profile', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [] }))
    await expect(StaffIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    expect(db.calls.filter(c => c.table === 'profiles')).toEqual([])
  })
})
