// WACONFIGFALLBACK.1 — the template header upload goes through Meta with the
// location's OWN number (its app id + token). The route named no location, so
// it always used the global env number's app. The route's soft contract is
// kept: the storage URL always comes back; with no number, handle is null and
// meta_error says why. Ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'prof-1', activeLocation: { id: 'a0000000-0000-4000-8000-000000000001' } })),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/whatsapp', () => ({ uploadMediaForTemplate: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST } from './route.js'
import { uploadMediaForTemplate } from '@/lib/whatsapp'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', appId: 'APP-SYNTH' }
const PATH = `${LOC}/b0000000-0000-4000-8000-000000000002.jpg`

function makeDb() {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00])
  return {
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([bytes]), error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.test/whatsapp-templates/x.jpg' } }),
        remove: () => Promise.resolve({ error: null }),
      }),
    },
  }
}

const call = () => POST(new Request('https://crm.test/api/whatsapp/templates/upload-media', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: PATH, format: 'IMAGE', mime: 'image/jpeg', file_name: 'x.jpg', location_id: LOC }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeDb())
  getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
  uploadMediaForTemplate.mockResolvedValue('h:handle-synth')
})

describe('POST upload-media — the location’s own number', () => {
  it('with a number: Meta upload uses THAT config and the handle comes back', async () => {
    const body = await (await call()).json()
    expect(body).toMatchObject({ success: true, handle: 'h:handle-synth', meta_error: null })
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
    expect(uploadMediaForTemplate.mock.calls[0][2]).toEqual({ config: NUMBER })
  })

  it('no number: Meta never called; URL still returned, handle null, meta_error says why', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    const body = await (await call()).json()
    expect(body).toMatchObject({
      success: true, handle: null, url: 'https://storage.test/whatsapp-templates/x.jpg',
      meta_error: 'No WhatsApp number is connected at this location.',
    })
    expect(uploadMediaForTemplate).not.toHaveBeenCalled()
  })
})
