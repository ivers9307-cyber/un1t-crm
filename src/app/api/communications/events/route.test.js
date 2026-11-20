import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

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

// Through the real withAuth wrapper (ROUTEWRAP.R5) over a schema-checked db.
const EV_A = 'e0000000-0000-4000-8000-0000000000a1'
const EV_B = 'e0000000-0000-4000-8000-0000000000b1'
const world = (errors = {}) => createFakeDb({
  tables: {
    race_events: [
      { id: EV_A, location_id: LOC_A, name: 'Open Day', kind: 'open_day', race_date: '2026-12-01' },
      { id: EV_B, location_id: LOC_B, name: 'Other Studio Race', kind: 'race', race_date: '2026-12-02' },
    ],
    race_registrations: [],
  },
  errors,
})

it('lists only the active studio\'s events, never another studio\'s', async () => {
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'manager' } }, LOC_A))
  createServerClient.mockReturnValue(world())
  const body = await (await GET()).json()
  expect(body.data.map((e) => e.id)).toEqual([EV_A])
})

it('403 "Manager+ required" judged at the active studio (manager elsewhere does not count)', async () => {
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'manager' } }, LOC_A))
  createServerClient.mockReturnValue(world())
  const res = await GET()
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
})

it('a failed read is a 400 without the database text', async () => {
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
  createServerClient.mockReturnValue(world({ race_events: { select: { message: 'secret detail' } } }))
  const res = await GET()
  expect(res.status).toBe(400)
  expect(JSON.stringify(await res.json())).not.toContain('secret detail')
})
