// Route tests for the public giversautos.com enquiry capture (GIVERS-WEB.1).
// Contract: validation 400s before any DB touch, rate limiting 429s
// before the insert, inserts normalise empty optionals to null, and a
// DB failure 500s with the phone number as the fallback contact.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: vi.fn(() => '1.2.3.4'),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => Response.json({ success: false }, { status: 429 })),
}))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/rate-limit'

function makeDb({ insertError = null } = {}) {
  const inserts = []
  return {
    from: (table) => ({
      insert: async (row) => { inserts.push({ table, row }); return { error: insertError } },
    }),
    _inserts: inserts,
  }
}
const makeReq = (body) => ({ json: async () => body, headers: { get: () => null } })

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true })
})

describe('POST /api/public/givers-enquiry', () => {
  it('missing name → 400 before any DB', async () => {
    const res = await POST(makeReq({ phone: '0868225779' }))
    expect(res.status).toBe(400)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('rate limited → 429, no insert', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    checkRateLimit.mockResolvedValue({ allowed: false })
    const res = await POST(makeReq({ name: 'Aoife', phone: '0861234567' }))
    expect(res.status).toBe(429)
    expect(db._inserts).toHaveLength(0)
  })

  it('valid enquiry inserts, empty optionals become null', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ name: 'Aoife', phone: '0861234567', email: '', message: '' }))
    expect(res.status).toBe(200)
    expect(db._inserts).toEqual([
      { table: 'car_enquiries', row: { name: 'Aoife', phone: '0861234567', email: null, message: null } },
    ])
  })

  it('insert failure → 500 with the phone number as fallback', async () => {
    createServerClient.mockReturnValue(makeDb({ insertError: { message: 'boom' } }))
    const res = await POST(makeReq({ name: 'Aoife', phone: '0861234567' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('086 822 5779')
  })
})
