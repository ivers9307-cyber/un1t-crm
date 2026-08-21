// src/app/api/live/[locationId]/contacts/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/class-bookings', () => ({ getClassRoster: vi.fn() }))

import { GET } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getClassRoster } from '@/lib/class-bookings'

function makeReq(q = '') {
  const url = q
    ? `http://localhost/api/live/loc1/contacts?q=${encodeURIComponent(q)}`
    : 'http://localhost/api/live/loc1/contacts'
  return new Request(url)
}
const props = { params: Promise.resolve({ locationId: 'loc1' }) }

// SEC-LIVE-API.1 — the gate now also requires `studio_management` at the
// location, so fixtures need the shape hasPermissionForLocation reads.
function userAt(role, { studio = true, locationId = 'loc1' } = {}) {
  return {
    id: 'u1',
    role,
    isMaster: false,
    locations: [{ id: locationId, features: {} }],
    assignmentsByLocation: {
      [locationId]: { role, permissions: studio === null ? {} : { studio_management: studio } },
    },
    roleTemplatesByLocation: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getUserLocationIds.mockReturnValue(['loc1'])
  getClassRoster.mockResolvedValue({ occurrence: null, roster: [] })
})

describe('GET /api/live/[locationId]/contacts', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(401)
  })

  it('403 when the location is not in scope', async () => {
    getCurrentUser.mockResolvedValue(userAt('staff'))
    getUserLocationIds.mockReturnValue(['other'])
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(403)
  })

  it('200 returns contacts without a query term', async () => {
    getCurrentUser.mockResolvedValue(userAt('staff'))
    const contacts = [{ id: 'c1', name: 'Alice' }, { id: 'c2', name: 'Bob' }]
    const terminal = Promise.resolve({ data: contacts, error: null })
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            or: () => ({ order: () => ({ limit: () => terminal }) }),
            order: () => ({ limit: () => terminal }),
          }),
        }),
      }),
    })
    const res = await GET(makeReq(), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.contacts).toHaveLength(2)
    expect(json.contacts[0]).toEqual({ id: 'c1', name: 'Alice', on_roster: false })
  })

  it('200 returns contacts for a search term', async () => {
    getCurrentUser.mockResolvedValue(userAt('staff'))
    const contacts = [{ id: 'c1', name: 'Alice Smith' }]
    const terminal = Promise.resolve({ data: contacts, error: null })
    const orFn = vi.fn(() => ({ order: () => ({ limit: () => terminal }) }))
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            or: orFn,
            order: () => ({ limit: () => terminal }),
          }),
        }),
      }),
    })
    const res = await GET(makeReq('alice'), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    // or filter should have been called with the search term
    expect(orFn).toHaveBeenCalledWith(expect.stringContaining('alice'))
  })

  it('ranks the live class roster first, deduped, with the class name (HR-CLAIM.1)', async () => {
    getCurrentUser.mockResolvedValue(userAt('staff'))
    getClassRoster.mockResolvedValue({
      occurrence: { glofox_event_id: 'ev1', class_name: 'UN1T Strength' },
      roster: [
        { contact_id: 'c5', member_name: 'Cara Doyle', status: 'BOOKED' },
        { contact_id: 'c1', member_name: 'Alice', status: 'BOOKED' },
      ],
    })
    const contacts = [{ id: 'c1', name: 'Alice' }, { id: 'c2', name: 'Bob' }]
    const terminal = Promise.resolve({ data: contacts, error: null })
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            or: () => ({ order: () => ({ limit: () => terminal }) }),
            order: () => ({ limit: () => terminal }),
          }),
        }),
      }),
    })
    const res = await GET(makeReq(), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.class_name).toBe('UN1T Strength')
    expect(json.contacts).toEqual([
      { id: 'c5', name: 'Cara Doyle', on_roster: true },
      { id: 'c1', name: 'Alice', on_roster: true },
      { id: 'c2', name: 'Bob', on_roster: false },
    ])
  })
})
