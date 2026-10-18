// WAORGNUMBER.1 — /api/whatsapp/spend enriches the local rollup with Meta's
// pricing_analytics for the studio's WABA. The WABA + token are the studio's
// SWITCHED-ON number (getLocationWhatsAppNumberConfig), whatever its home studio.
// Ids are synthetic.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ fetchPricingAnalytics: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { fetchPricingAnalytics } from '@/lib/whatsapp-pricing'
import { LOC_B, person } from '../../../../../tests/helpers/owner-at-location-callers.js'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const ROLLUP = [{ category: 'utility', messages: 3 }]
const get = (loc = LOC) => new Request(`http://localhost/api/whatsapp/spend?location_id=${loc}&months=2`)

let db
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(person({ [LOC]: 'owner' }, LOC))
  db = { from: vi.fn(() => { throw new Error('whatsapp_numbers must not be read by id-less location filter') }), rpc: vi.fn(async () => ({ data: ROLLUP })) }
  createServerClient.mockReturnValue(db)
  fetchPricingAnalytics.mockResolvedValue({ data: 'analytics' })
})

describe('GET /api/whatsapp/spend', () => {
  it('asks Meta about the WABA of the number switched on at the studio', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue({ id: 'n1', businessAccountId: 'WABA-SYNTH', token: 'tok-synth', homeLocationId: LOC_B })
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(fetchPricingAnalytics).toHaveBeenCalledWith({ wabaId: 'WABA-SYNTH', accessToken: 'tok-synth' }, expect.objectContaining({ granularity: 'MONTHLY' }))
    expect((await res.json()).data).toMatchObject({ rollup: ROLLUP, meta: { data: 'analytics' } })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('no number switched on (or no WABA / token) → meta null, rollup still served', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    expect((await (await GET(get())).json()).data).toMatchObject({ rollup: ROLLUP, meta: null })
    getLocationWhatsAppNumberConfig.mockResolvedValue({ id: 'n1', businessAccountId: null, token: 'tok-synth' })
    expect((await (await GET(get())).json()).data.meta).toBeNull()
    expect(fetchPricingAnalytics).not.toHaveBeenCalled()
  })

  it('a failed number lookup is optional enrichment lost, logged: meta null, still 200', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('boom'))
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect((await res.json()).data.meta).toBeNull()
    expect(errSpy).toHaveBeenCalledWith('[wa-spend] pricing_analytics failed:', 'boom')
    errSpy.mockRestore()
  })

  it('a non-member is refused before anything is read', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: 'owner' }, LOC_B))
    const res = await GET(get())
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })
})
