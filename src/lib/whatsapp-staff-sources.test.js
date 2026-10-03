// C106 CHECKINRISKS.1 (d) — one definition of "a person on the studio's side
// wrote this WhatsApp message", shared by the check-in runner, Mia's
// take-over checks and the handoff SLA sweep.
import { describe, it, expect } from 'vitest'
import {
  WA_APP_ECHO_SOURCE,
  WA_PHONE_APP_SOURCES,
  isWhatsAppStaffAuthored,
  isWhatsAppStaffOutbound,
  WA_STAFF_OUTBOUND_OR_FILTER,
} from './whatsapp-staff-sources.js'

describe('isWhatsAppStaffAuthored', () => {
  it('a reply typed in the studio phone app (app_echo, no sent_by) is staff', () => {
    expect(isWhatsAppStaffAuthored({ source: 'app_echo', sent_by: null })).toBe(true)
  })
  it('an inbox send (sent_by set) is staff', () => {
    expect(isWhatsAppStaffAuthored({ source: 'api', sent_by: 'staff-1' })).toBe(true)
  })
  it('an automation (source api, no sent_by) is not staff', () => {
    expect(isWhatsAppStaffAuthored({ source: 'api', sent_by: null })).toBe(false)
  })
  it("Mia's own message is never staff, even with a sent_by", () => {
    expect(isWhatsAppStaffAuthored({ source: 'agent', sent_by: null })).toBe(false)
    expect(isWhatsAppStaffAuthored({ source: 'agent', sent_by: 'staff-1' })).toBe(false)
  })
  it('a missing row is not staff', () => {
    expect(isWhatsAppStaffAuthored(null)).toBe(false)
    expect(isWhatsAppStaffAuthored(undefined)).toBe(false)
  })
})

describe('isWhatsAppStaffOutbound', () => {
  it('needs an outbound row', () => {
    expect(isWhatsAppStaffOutbound({ direction: 'outbound', source: 'app_echo', sent_by: null })).toBe(true)
    expect(isWhatsAppStaffOutbound({ direction: 'inbound', source: 'app_echo', sent_by: null })).toBe(false)
  })
})

describe('the source vocabulary', () => {
  it('names the phone-app echo source the DB CHECK allows (mig 259)', () => {
    expect(WA_APP_ECHO_SOURCE).toBe('app_echo')
    expect(WA_PHONE_APP_SOURCES).toEqual(['app_echo', 'history_sync'])
  })
  it('the PostgREST filter says the same thing as the JS predicate', () => {
    expect(WA_STAFF_OUTBOUND_OR_FILTER).toBe('sent_by.not.is.null,source.in.(operator,app_echo,history_sync)')
  })
})
