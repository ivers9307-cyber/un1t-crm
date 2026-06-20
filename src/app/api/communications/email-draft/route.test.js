import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => { vi.clearAllMocks() })

function dbCapturingInsert(captured) {
  const chain = {
    insert: (row) => { captured.row = row; return chain },
    select: () => chain,
    single: () => Promise.resolve({ data: { id: 'camp-1' }, error: null }),
  }
  return { from: () => chain }
}

function req(body) {
  return new Request('http://localhost/api/communications/email-draft', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

it('maps email_type=utility → postmark_stream=outbound on insert', async () => {
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'loc-1' }, role: 'owner' })
  const captured = {}
  createServerClient.mockReturnValue(dbCapturingInsert(captured))
  const res = await POST(req({ location_id: '00000000-0000-0000-0000-000000000001', name: 'Workshop logistics', email_type: 'utility' }))
  expect(res.status).toBe(200)
  expect(captured.row.postmark_stream).toBe('outbound')
})

it('defaults to postmark_stream=broadcast when email_type omitted', async () => {
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: 'loc-1' }, role: 'owner' })
  const captured = {}
  createServerClient.mockReturnValue(dbCapturingInsert(captured))
  const res = await POST(req({ location_id: '00000000-0000-0000-0000-000000000001', name: 'June newsletter' }))
  expect(res.status).toBe(200)
  expect(captured.row.postmark_stream).toBe('broadcast')
})
