// src/app/api/live/[locationId]/contacts/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))

import { GET } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function makeReq(q = '') {
  const url = q
    ? `http://localhost/api/live/loc1/contacts?q=${encodeURIComponent(q)}`
    : 'http://localhost/api/live/loc1/contacts'
  return new Request(url)
}
const props = { params: Promise.resolve({ locationId: 'loc1' }) }

function makeDb(contacts = []) {
  const terminal = Promise.resolve({ data: contacts, error: null })
  const limit = vi.fn(() => terminal)
  const order = vi.fn(() => ({ limit }))
  const orFn = vi.fn(() => ({ order }))
  const eq = vi.fn(() => ({ or: orFn, order }))
  const select = vi.fn(() => ({ eq }))
  // expose orFn so tests can assert on it
  const from = vi.fn(() => ({ select }))
  return { client: { from }, eq, orFn, order, limit }
}

beforeEach(() => { vi.clearAllMocks(); getUserLocationIds.mockReturnValue(['loc1']) })

describe('GET /api/live/[locationId]/contacts', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(401)
  })

  it('403 when the location is not in scope', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', isMaster: false })
    getUserLocationIds.mockReturnValue(['other'])
    const res = await GET(makeReq(), props)
    expect(res.status).toBe(403)
  })

  it('200 returns contacts without a query term', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', isMaster: false })
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
    expect(json.contacts[0].name).toBe('Alice')
  })

  it('200 returns contacts for a search term', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u1', role: 'staff', isMaster: false })
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
})
