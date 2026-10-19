// GLOFOXSIBLING.1 — the one-off repair lists only Glofox members with no
// contact at the studio whose contact lives at a sibling studio, and syncs
// only them when asked.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/glofox', () => ({ glofoxCredentialsForLocation: vi.fn(), fetchAllMembersPage: vi.fn() }))
vi.mock('@/lib/glofox-sync', () => ({ applyMemberSync: vi.fn() }))
vi.mock('@/lib/glofox-crossover', () => ({ findGlofoxCrossoverContact: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { glofoxCredentialsForLocation, fetchAllMembersPage } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { findGlofoxCrossoverContact } from '@/lib/glofox-crossover'

const LOC = '11111111-1111-4111-8111-111111111111'

// Studio contacts: g-here by id, here@x.com by email.
function makeDb() {
  const from = () => {
    const q = { filters: [] }
    const chain = {}
    chain.select = () => chain
    chain.eq = (c, v) => { q.filters.push([c, v]); return chain }
    chain.in = (c, v) => { q.in = [c, v]; return chain }
    chain.then = (resolve) => {
      const [col] = q.in
      if (col === 'glofox_member_id') return resolve({ data: [{ glofox_member_id: 'g-here' }], error: null })
      return resolve({ data: [{ email: 'Here@X.com' }], error: null })
    }
    return chain
  }
  return { from }
}

const post = (body) => POST(new Request('http://localhost/api/glofox/crossover-backfill', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ role: 'master' })
  createServerClient.mockReturnValue(makeDb())
  glofoxCredentialsForLocation.mockResolvedValue({ branchId: 'b', apiKey: 'k', apiToken: 't', readError: null })
  fetchAllMembersPage.mockResolvedValue({
    data: [
      { _id: 'g-here', email: 'someone@x.com' },          // held at the studio by id
      { _id: 'g-mail', email: 'HERE@x.com' },              // held at the studio by email
      { _id: 'g-craig', email: 'craig@x.com' },            // sibling studio contact
      { _id: 'g-new', email: 'new@x.com' },                // nobody: the sync will create
      { _id: 'g-two', email: 'two@x.com' },                // conflict
    ],
    total: 5, hasMore: false,
  })
  findGlofoxCrossoverContact.mockImplementation(async (_db, _loc, { glofoxMemberId }) => {
    if (glofoxMemberId === 'g-craig') return { contact: { id: 'c-hatch', location_id: 'hatch' }, how: 'email' }
    if (glofoxMemberId === 'g-two') return { contact: null, conflict: { reason: 'Two contacts', contact_ids: ['a', 'b'] } }
    return { contact: null }
  })
  applyMemberSync.mockResolvedValue({ action: 'update', contact_id: 'c-hatch', crossover_link: { linked: true } })
})

describe('POST /api/glofox/crossover-backfill', () => {
  it('master only', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner' })
    expect((await post({ location_id: LOC })).status).toBe(403)
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ location_id: LOC })).status).toBe(401)
  })

  it('dry run (the default) lists the sibling-studio candidates and conflicts, ids only, and writes nothing', async () => {
    const { data } = await (await post({ location_id: LOC })).json()
    expect(data.dry_run).toBe(true)
    expect(data.candidates).toEqual([{ glofox_member_id: 'g-craig', contact_id: 'c-hatch', home_location_id: 'hatch', how: 'email' }])
    expect(data.conflicts).toEqual([{ glofox_member_id: 'g-two', contact_ids: ['a', 'b'], reason: 'Two contacts' }])
    // members the studio already holds are never looked up across the org
    const looked = findGlofoxCrossoverContact.mock.calls.map((c) => c[2].glofoxMemberId)
    expect(looked).toEqual(['g-craig', 'g-new', 'g-two'])
    expect(applyMemberSync).not.toHaveBeenCalled()
    expect(JSON.stringify(data)).not.toContain('@')
  })

  it('dry_run:false syncs only the candidates', async () => {
    const { data } = await (await post({ location_id: LOC, dry_run: false })).json()
    expect(applyMemberSync).toHaveBeenCalledTimes(1)
    expect(applyMemberSync.mock.calls[0][2]).toMatchObject({ _id: 'g-craig' })
    expect(data.applied).toEqual([{ glofox_member_id: 'g-craig', contact_id: 'c-hatch', action: 'update', linked: true, error: null }])
  })
})
