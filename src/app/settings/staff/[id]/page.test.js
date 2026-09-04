// STAFF-PAGE-GATE.1 — the staff editor must establish that this PERSON is
// the caller's to see, before it reads anything about them.
//
// The defect: the page gated on the caller's ACTIVE-location role ("you are
// an owner somewhere") and then read the target profile with the
// SERVICE-ROLE client, which bypasses RLS. Nothing scoped that read, so any
// owner-role user could open /settings/staff/<any profile id> and receive
// the full profiles row plus EVERY profile_locations assignment — including
// staff in another organisation. Personal data, so the refusal must land
// BEFORE the profile is read, not after.
//
// The rule under test: the target must work somewhere the caller OWNS
// (master unrestricted; a profile assigned nowhere is open to any owner, so
// removing someone's last assignment cannot lock every owner out).
//
// `@/lib/auth` is only PARTIALLY mocked — getCurrentUser is a stub, the
// guards are real. next/navigation throws the way production does.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import EditStaffPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { notFound, redirect } from 'next/navigation'

const LOC_MINE = 'a0000000-0000-0000-0000-000000000001'
const LOC_THEIRS = 'b0000000-0000-0000-0000-000000000002' // another org's studio
const TARGET = 'c0000000-0000-0000-0000-000000000003'

// Records which tables were read, so "never read the person" is an
// assertion rather than an assumption.
function makeDb({ targetLocationIds = [LOC_THEIRS], locError = null } = {}) {
  const touched = []
  const from = (table) => {
    touched.push(table)
    if (table === 'profile_locations') {
      return {
        select: () => ({
          eq: () => Promise.resolve({
            data: locError ? null : targetLocationIds.map(location_id => ({ location_id })),
            error: locError,
          }),
        }),
      }
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: TARGET, role: 'staff', name: 'Someone Else',
                email: 'someone@example.com',
                profile_locations: targetLocationIds.map(location_id => ({ location_id, role: 'staff' })),
              },
            }),
          }),
        }),
      }
    }
    // locations / location_role_permissions / profile_organizations
    const chain = {}
    for (const op of ['select', 'eq', 'order']) chain[op] = () => chain
    chain.then = (res) => Promise.resolve({ data: [] }).then(res)
    return chain
  }
  return { touched, from }
}

const user = ({ role, isMaster = false, rolesByLocation }) => ({
  id: 'u1', role, isMaster, rolesByLocation,
  locations: Object.keys(rolesByLocation || {}).map(id => ({ id })),
  activeLocation: { id: LOC_MINE },
})

const call = () => EditStaffPage({ params: Promise.resolve({ id: TARGET }) })

describe('/settings/staff/[id] — the target must be the caller’s to see', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb()
    createServerClient.mockReturnValue(db)
  })

  it('refuses a profile who works only at a studio the caller does not own, without reading them', async () => {
    // The exploit: a real owner, guessing another org's profile id.
    getCurrentUser.mockResolvedValue(user({ role: 'owner', rolesByLocation: { [LOC_MINE]: 'owner' } }))

    await expect(call()).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFound).toHaveBeenCalled()
    // 404, never a redirect — profile ids must not be enumerable.
    expect(redirect).not.toHaveBeenCalled()
    // The whole point: the person's record was never read.
    expect(db.touched).not.toContain('profiles')
    expect(db.touched).toEqual(['profile_locations'])
  })

  it('allows an owner when the target works at a studio they own', async () => {
    db = makeDb({ targetLocationIds: [LOC_MINE, LOC_THEIRS] })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(user({ role: 'owner', rolesByLocation: { [LOC_MINE]: 'owner' } }))

    await call()

    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toContain('profiles')
  })

  it('allows a master unrestricted — and asks profile_locations nothing first', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'master', isMaster: true, rolesByLocation: {} }))

    await call()

    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toContain('profiles')
    expect(db.touched).not.toContain('profile_locations')
  })

  it('allows any owner to open a profile assigned NOWHERE — otherwise the last removal locks everyone out', async () => {
    db = makeDb({ targetLocationIds: [] })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(user({ role: 'owner', rolesByLocation: { [LOC_MINE]: 'owner' } }))

    await call()

    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toContain('profiles')
  })

  it('treats an unreadable assignment list as refusal, not permission', async () => {
    db = makeDb({ locError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(user({ role: 'owner', rolesByLocation: { [LOC_MINE]: 'owner' } }))

    await expect(call()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(db.touched).not.toContain('profiles')
  })

  it('refuses an owner-role caller who owns no location at all, before any query', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'owner', rolesByLocation: { [LOC_MINE]: 'manager' } }))

    await expect(call()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(db.touched).toEqual([])
  })

  it('still bounces a non-owner outright', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'staff', rolesByLocation: { [LOC_MINE]: 'staff' } }))

    await expect(call()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    expect(db.touched).toEqual([])
  })
})
