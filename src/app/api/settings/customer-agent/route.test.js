import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

function putReq(body) {
  return new Request('http://x/api/settings/customer-agent', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('PUT /api/settings/customer-agent — CTA fields', () => {
  it('403 for a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'staff', activeLocation: { id: 'loc1' } })
    expect((await PUT(putReq({ enabled: true }))).status).toBe(403)
  })

  it('persists booking_url + the two CTA labels into settings.customer_agent', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    const res = await PUT(putReq({
      enabled: true,
      membership_signup_url: 'https://join.example',
      booking_url: 'https://book.example/ride',
      booking_cta_label: 'Book a class',
      membership_cta_label: 'Join us',
    }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent).toMatchObject({
      membership_signup_url: 'https://join.example',
      booking_url: 'https://book.example/ride',
      booking_cta_label: 'Book a class',
      membership_cta_label: 'Join us',
    })
  })

  it('coerces blank/invalid to null', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: 'loc1' } })
    let written = null
    createServerClient.mockReturnValue({
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { settings: {} }, error: null }) }) }),
        update: (patch) => { written = patch; return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1' }, error: null }) }) }) } },
      }),
    })
    const res = await PUT(putReq({ enabled: true, booking_url: '', booking_cta_label: '   ' }))
    expect(res.status).toBe(200)
    expect(written.settings.customer_agent.booking_url).toBeNull()
    expect(written.settings.customer_agent.booking_cta_label).toBeNull()
  })
})
