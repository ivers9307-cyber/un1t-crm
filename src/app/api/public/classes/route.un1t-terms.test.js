// UN1TWRITE.18 — GET /api/public/classes tells the funnel whether the terms
// and waiver tick is required (a un1t.online studio with the funnel on) and
// what it says.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let pageBlocks = []
const db = {
  from() {
    const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { location_id: 'L1', public_path: 'hatch-street', blocks: pageBlocks }, error: null }) }
    return b
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ getClientIp: () => '1.2.3.4', checkRateLimit: vi.fn(async () => ({ allowed: true })), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/public-classes', () => ({ listPublicClasses: vi.fn(async () => [{ event_id: 'un1t:e-1' }]) }))
let settings
vi.mock('@/lib/un1t-online-settings', async (importOriginal) => ({ ...(await importOriginal()), readUn1tWriteSettings: vi.fn(async () => settings) }))

import { GET } from './route.js'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'

const get = async () => (await GET(new Request('http://localhost/api/public/classes?path=hatch-street'))).json()
const un1t = (funnel) => ({ membershipSource: 'un1t_online', studioName: 'Hatch Street', settings: { writesEnabled: funnel, funnelEnabled: funnel } })

beforeEach(() => { vi.clearAllMocks(); pageBlocks = [{ type: 'class_funnel' }]; settings = un1t(true) })

describe('UN1TWRITE.18 — data.terms', () => {
  it('funnel on: required, with the label, link labels, message and both page urls', async () => {
    const j = await get()
    expect(j.data.classes).toHaveLength(1)
    expect(j.data.terms).toEqual({
      required: true,
      label: "I accept Hatch Street's {terms} and {waiver}",
      terms_link_label: 'terms and conditions',
      waiver_link_label: 'liability waiver',
      required_message: 'Please tick to accept the terms and waiver.',
      terms_url: '/legal/un1t/hatch-street/terms',
      waiver_url: '/legal/un1t/hatch-street/waiver',
    })
  })

  it('funnel off, a Glofox studio or an unreadable settings row: not required', async () => {
    settings = un1t(false)
    expect((await get()).data.terms).toEqual({ required: false })
    settings = { membershipSource: 'glofox', studioName: 'S', settings: { writesEnabled: false, funnelEnabled: false } }
    expect((await get()).data.terms).toEqual({ required: false })
    readUn1tWriteSettings.mockRejectedValueOnce(new Error('down'))
    const j = await get()
    expect(j.data.terms).toEqual({ required: false })
    expect(j.data.classes).toHaveLength(1)
  })
})
