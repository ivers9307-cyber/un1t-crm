import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/customer-auth', () => ({ resolveCustomerContact: vi.fn() }))

import { POST, DELETE } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'

function makeDb() {
  const calls = { upsert: null, update: null, updateFilters: {} }
  const db = {
    from() {
      return {
        upsert(row) { calls.upsert = row; return Promise.resolve({ error: null }) },
        update(patch) {
          calls.update = patch
          const chain = { eq(col, val) { calls.updateFilters[col] = val; return chain } }
          // chain is awaited after the two .eq()s → resolve there
          chain.then = (resolve) => Promise.resolve({ error: null }).then(resolve)
          return chain
        },
      }
    },
  }
  db.calls = calls
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveCustomerContact.mockResolvedValue({ contact: { id: 'c-1', location_id: 'loc-1' } })
})

describe('apple-health connect', () => {
  it('POST upserts an active apple_health connection (sentinel token)', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    const res = await POST({ headers: { get: () => 'Bearer t' } })
    expect((await res.json()).success).toBe(true)
    expect(db.calls.upsert).toEqual(expect.objectContaining({
      contact_id: 'c-1', provider: 'apple_health', provider_user_id: 'c-1',
      status: 'active', access_token: 'direct-healthkit',
    }))
  })

  it('DELETE revokes the connection', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    const res = await DELETE({ headers: { get: () => 'Bearer t' } })
    expect((await res.json()).success).toBe(true)
    expect(db.calls.update).toEqual({ status: 'revoked', last_error: null })
    expect(db.calls.updateFilters).toEqual({ contact_id: 'c-1', provider: 'apple_health' })
  })

  it('401 when unauthorised', async () => {
    resolveCustomerContact.mockResolvedValue({ error: 'unauthorised' })
    createServerClient.mockReturnValue(makeDb())
    const res = await POST({ headers: { get: () => null } })
    expect(res.status).toBe(401)
  })
})
