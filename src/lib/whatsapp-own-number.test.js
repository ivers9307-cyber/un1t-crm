// WACONFIGFALLBACK.1 — ownNumberOrRefusal: the one answer every route that
// acts AT META for a location (templates, openers, uploads) gives when the
// location has no number, or when the lookup itself failed. Ids synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { ownNumberOrRefusal } from './whatsapp-own-number.js'
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { logError } from '@/lib/log'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const NUMBER = { source: 'db', id: 'n1', phoneNumberId: 'PNI-SYNTH', token: 'tok-synth', businessAccountId: 'WABA-SYNTH' }

beforeEach(() => vi.clearAllMocks())

describe('ownNumberOrRefusal', () => {
  it("the location's own number → ok with that config", async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
    expect(await ownNumberOrRefusal(LOC, 'scope-x')).toEqual({ ok: true, config: NUMBER })
    expect(getLocationWhatsAppNumberConfig).toHaveBeenCalledWith(LOC)
  })

  it('no number → 409 with the shared message (never the env number)', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(null)
    expect(await ownNumberOrRefusal(LOC, 'scope-x')).toEqual({
      ok: false, status: 409, error: 'No WhatsApp number is connected at this location.',
    })
    expect(logError).not.toHaveBeenCalled()
  })

  it('a failed lookup → 500 + a structured log (never read as "no number")', async () => {
    getLocationWhatsAppNumberConfig.mockRejectedValue(new Error('db down'))
    expect(await ownNumberOrRefusal(LOC, 'scope-x')).toEqual({
      ok: false, status: 500, error: "Could not check this location's WhatsApp number just now.",
    })
    expect(logError).toHaveBeenCalledWith('scope-x', 'number lookup failed', { locationId: LOC, err: 'db down' })
  })

  it('no location id → 409 without a lookup', async () => {
    expect(await ownNumberOrRefusal(null, 'scope-x')).toEqual({
      ok: false, status: 409, error: 'No location was given to send this WhatsApp from.',
    })
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })
})
