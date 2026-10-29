// POST /api/sequences accepts the un1t_account_created trigger (UN1TWELCOME.2).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(),
}))
vi.mock('@/lib/sequence-access', () => ({
  canBuildSequencesAt: vi.fn(() => true),
  canBuildSequencesSomewhere: vi.fn(() => true),
  sequencePermissionRequired: vi.fn(),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'c0000000-0000-0000-0000-000000000003'

beforeEach(() => {
  getCurrentUser.mockResolvedValue({ id: 'u', activeLocation: { id: LOC } })
})

describe('POST /api/sequences', () => {
  it('accepts trigger_type un1t_account_created', async () => {
    const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 's1' }, error: null }) }) }))
    createServerClient.mockReturnValue({ from: () => ({ insert }) })
    const res = await POST(new Request('http://x/api/sequences', {
      method: 'POST',
      body: JSON.stringify({ name: 'Welcome', trigger_type: 'un1t_account_created', location_id: LOC }),
    }))
    expect(res.status).toBe(200)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ trigger_type: 'un1t_account_created' }))
  })
})
