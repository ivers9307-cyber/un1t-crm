import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/class-categories', async (orig) => {
  const actual = await orig()
  return { ...actual, loadSeenClassCategories: vi.fn(async () => [{ class_name: 'RIDE', category: 'cardio' }]) }
})

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())
const LOC = '00000000-0000-0000-0000-000000000001'

function req(url, body) {
  return new Request(url, body ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
}

describe('GET /api/settings/class-categories', () => {
  it('403 for a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'staff', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'staff' } })
    const res = await GET(req(`http://x/api/settings/class-categories?location_id=${LOC}`))
    expect(res.status).toBe(403)
  })
  it('200 returns seen + mappings for a manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
    createServerClient.mockReturnValue({})
    const res = await GET(req(`http://x/api/settings/class-categories?location_id=${LOC}`))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.seen[0]).toMatchObject({ class_name: 'RIDE', category: 'cardio' })
  })
})

describe('PUT /api/settings/class-categories', () => {
  it('upserts set categories + deletes cleared ones', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
    const upserts = []; const deletes = []
    createServerClient.mockReturnValue({
      from: () => ({
        upsert: (rows, opts) => { upserts.push({ rows, opts }); return Promise.resolve({ error: null }) },
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      }),
    })
    // capture deletes via a from() that records the table op
    createServerClient.mockReturnValue({
      from: (t) => ({
        upsert: (rows, opts) => { upserts.push({ rows, opts }); return Promise.resolve({ error: null }) },
        delete: () => ({ eq: () => ({ eq: (col, val) => { deletes.push(val); return Promise.resolve({ error: null }) } }) }),
      }),
    })
    const res = await PUT(req('http://x/api/settings/class-categories', {
      location_id: LOC,
      entries: [{ class_name: 'RIDE', category: 'cardio' }, { class_name: 'OLD', category: null }],
    }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(upserts[0].rows[0]).toMatchObject({ location_id: LOC, class_name: 'RIDE', class_name_normalized: 'ride', category: 'cardio' })
    expect(upserts[0].opts).toEqual({ onConflict: 'location_id,class_name_normalized' })
    expect(deletes).toContain('old') // normalized 'OLD'
  })
  it('400 on an invalid category', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
    createServerClient.mockReturnValue({ from: () => ({}) })
    const res = await PUT(req('http://x/api/settings/class-categories', { location_id: LOC, entries: [{ class_name: 'X', category: 'bogus' }] }))
    expect(res.status).toBe(400)
  })
})
