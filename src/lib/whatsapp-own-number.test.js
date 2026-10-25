// WACONFIGFALLBACK.1 — ownNumberOrRefusal: the one answer every route that
// acts AT META for a location (templates, openers, uploads) gives when the
// location has no number, or when the lookup itself failed. Ids synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn(), getLocationNumberForWaba: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { ownNumberOrRefusal, templateNumberOrRefusal } from './whatsapp-own-number.js'
import { getLocationWhatsAppNumberConfig, getLocationNumberForWaba } from '@/lib/whatsapp-config'
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

// WAORGNUMBER.2 (R5) — template edit / delete run on the template's OWN WABA.
describe('templateNumberOrRefusal', () => {
  it('the studio’s number on the template’s WABA', async () => {
    getLocationNumberForWaba.mockResolvedValue(NUMBER)
    expect(await templateNumberOrRefusal({ location_id: LOC, business_account_id: 'WABA-SYNTH' }, 'scope-x')).toEqual({ ok: true, config: NUMBER })
    expect(getLocationNumberForWaba).toHaveBeenCalledWith(LOC, 'WABA-SYNTH')
    expect(getLocationWhatsAppNumberConfig).not.toHaveBeenCalled()
  })

  it('none on that WABA → 409 with the switched-off copy', async () => {
    getLocationNumberForWaba.mockResolvedValue(null)
    expect(await templateNumberOrRefusal({ location_id: LOC, business_account_id: 'WABA-2' }, 'scope-x')).toEqual({
      ok: false, status: 409, error: 'The number this template lives on is switched off at this studio.',
    })
  })

  it('a failed lookup → 500, logged', async () => {
    getLocationNumberForWaba.mockRejectedValue(new Error('db down'))
    expect(await templateNumberOrRefusal({ location_id: LOC, business_account_id: 'WABA-2' }, 'scope-x')).toMatchObject({ ok: false, status: 500 })
    expect(logError).toHaveBeenCalledWith('scope-x', 'number lookup failed', { locationId: LOC, wabaId: 'WABA-2', err: 'db down' })
  })

  it('no WABA recorded → ownNumberOrRefusal (the studio default)', async () => {
    getLocationWhatsAppNumberConfig.mockResolvedValue(NUMBER)
    expect(await templateNumberOrRefusal({ location_id: LOC, business_account_id: null }, 'scope-x')).toEqual({ ok: true, config: NUMBER })
    expect(getLocationNumberForWaba).not.toHaveBeenCalled()
  })
})
