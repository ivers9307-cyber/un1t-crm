import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => { vi.clearAllMocks() })

it('401 when not signed in', async () => {
  getCurrentUser.mockResolvedValue(null)
  const res = await GET()
  expect(res.status).toBe(401)
})

it('403 for non-manager roles', async () => {
  getCurrentUser.mockResolvedValue({ role: 'staff', activeLocation: { id: 'loc-1' } })
  const res = await GET()
  expect(res.status).toBe(403)
})

it('returns events with a live registration_count, scoped to the active location', async () => {
  getCurrentUser.mockResolvedValue({ role: 'owner', activeLocation: { id: 'loc-1' } })

  // events list query: .from('race_events').select().order().limit().eq()  → { data, error }
  const listChain = {
    select: () => listChain, order: () => listChain, limit: () => listChain, eq: () => listChain,
    then: (r) => Promise.resolve({ data: [{ id: 'evt-1', name: 'Nutrition Seminar', kind: 'seminar', race_date: '2026-06-28' }], error: null }).then(r),
  }
  // count query: .from('race_registrations').select(head).eq().in() → { count }
  const countChain = {
    select: () => countChain, eq: () => countChain, in: () => countChain,
    then: (r) => Promise.resolve({ count: 23, error: null }).then(r),
  }
  createServerClient.mockReturnValue({
    from: (t) => (t === 'race_events' ? listChain : countChain),
  })

  const res = await GET()
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.success).toBe(true)
  expect(body.data).toEqual([
    { id: 'evt-1', name: 'Nutrition Seminar', kind: 'seminar', race_date: '2026-06-28', registration_count: 23 },
  ])
})
