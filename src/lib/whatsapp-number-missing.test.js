// WACONFIGFALLBACK.1 — the typed refusal every WhatsApp caller shares when a
// location has no active whatsapp_numbers row of its own. Pure module: no
// imports, so any test (or mocked module graph) can build and recognise one.

import { describe, it, expect } from 'vitest'
import {
  WhatsAppNumberMissingError,
  isWhatsAppNumberMissing,
  whatsappErrorStatus,
  NO_WHATSAPP_NUMBER_MESSAGE,
  NO_LOCATION_MESSAGE,
  WA_NO_NUMBER,
} from './whatsapp-number-missing.js'

describe('WhatsAppNumberMissingError', () => {
  it('carries the code, the location and the staff-facing message', () => {
    const e = new WhatsAppNumberMissingError('loc-1')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('WhatsAppNumberMissingError')
    expect(e.code).toBe(WA_NO_NUMBER)
    expect(e.locationId).toBe('loc-1')
    expect(e.message).toBe(NO_WHATSAPP_NUMBER_MESSAGE)
    expect(NO_WHATSAPP_NUMBER_MESSAGE).toBe('No WhatsApp number is connected at this location.')
  })

  it('no location → says so (a caller that passed nothing, never "this location")', () => {
    const e = new WhatsAppNumberMissingError(null)
    expect(e.locationId).toBeNull()
    expect(e.message).toBe(NO_LOCATION_MESSAGE)
  })
})

describe('isWhatsAppNumberMissing', () => {
  it('recognises the typed error by its code (survives a module boundary / a mock)', () => {
    expect(isWhatsAppNumberMissing(new WhatsAppNumberMissingError('loc-1'))).toBe(true)
    expect(isWhatsAppNumberMissing(Object.assign(new Error('x'), { code: WA_NO_NUMBER }))).toBe(true)
  })

  it('anything else is not a missing number', () => {
    expect(isWhatsAppNumberMissing(new Error('Invalid OAuth access token'))).toBe(false)
    expect(isWhatsAppNumberMissing(null)).toBe(false)
    expect(isWhatsAppNumberMissing(undefined)).toBe(false)
  })
})

describe('whatsappErrorStatus', () => {
  it('a missing number is a 409 (the location is not set up), whatever the route used before', () => {
    expect(whatsappErrorStatus(new WhatsAppNumberMissingError('loc-1'), 502)).toBe(409)
    expect(whatsappErrorStatus(new WhatsAppNumberMissingError('loc-1'), 400)).toBe(409)
  })

  it("any other error keeps the route's own status", () => {
    expect(whatsappErrorStatus(new Error('Meta said no'), 502)).toBe(502)
    expect(whatsappErrorStatus(new Error('Meta said no'), 400)).toBe(400)
  })
})
