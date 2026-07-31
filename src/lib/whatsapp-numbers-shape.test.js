// src/lib/whatsapp-numbers-shape.test.js
import { describe, it, expect } from 'vitest'
import { redactToken, publicShape } from './whatsapp-numbers-shape.js'

describe('redactToken', () => {
  it('shows only the last 6 chars', () => {
    expect(redactToken('EAAG1234567890abcdef')).toBe('••••abcdef')
  })
  it('fully masks short/absent tokens', () => {
    expect(redactToken('short')).toBe('••••')
    expect(redactToken(null)).toBe(null)
  })
})

describe('publicShape', () => {
  it('never leaks access_token or signup_meta (holds the 2FA PIN), but exposes a coarse history_sync_status', () => {
    const shaped = publicShape({
      id: 'r1', location_id: 'L1', label: 'x', phone_number_id: '1',
      access_token: 'EAAGtechprovSECRETzz',           // 20 chars → redacts to last 6
      signup_meta: { pin: '123456', history_sync: { status: 'importing', started_at: '2026-07-16T10:00:00.000Z' } },
      token_type: 'business', connected_via: 'embedded_signup',
      business_account_id: 'w', app_id: 'a', display_phone: 'd', source: 'cloud_api',
      is_default: true, is_active: true, created_at: 'c', updated_at: 'u',
    })
    expect(JSON.stringify(shaped)).not.toContain('EAAGtechprovSECRETzz')
    expect(JSON.stringify(shaped)).not.toContain('123456')
    expect(shaped.access_token_redacted).toBe('••••CRETzz')
    expect(shaped.token_type).toBe('business')
    expect(shaped.connected_via).toBe('embedded_signup')
    expect(shaped.history_sync_status).toBe('importing')
    expect(shaped.history_sync_started_at).toBe('2026-07-16T10:00:00.000Z')
  })

  it('defaults history_sync_status to null when there is no signup_meta', () => {
    const shaped = publicShape({
      id: 'r2', location_id: 'L1', label: 'x', phone_number_id: '1',
      access_token: null, token_type: 'business', connected_via: 'coexistence',
      business_account_id: 'w', app_id: 'a', display_phone: 'd', source: 'coexistence',
      is_default: false, is_active: true, created_at: 'c', updated_at: 'u',
    })
    expect(shaped.history_sync_status).toBe(null)
    expect(shaped.coex_link_status).toBe(null)
    expect(shaped.coex_offboarded_at).toBe(null)
  })

  // WA-COEX.6 — the link state is surfaced so the settings UI can explain a
  // dead number, but it rides in signup_meta alongside the 2FA PIN: only the
  // two scalars may cross the wire.
  it('exposes coexistence link state without leaking the rest of signup_meta', () => {
    const shaped = publicShape({
      id: 'r3', location_id: 'L1', label: 'Stillorgan', phone_number_id: '1',
      access_token: 'EAAcoexSECRETtoken00',
      signup_meta: {
        pin: '654321',
        coex_link: {
          status: 'offboarded', event: 'ACCOUNT_OFFBOARDED',
          offboarded_at: '2026-07-31T10:00:00.000Z', reconnected_at: null,
          updated_at: '2026-07-31T10:00:00.000Z',
        },
      },
      token_type: 'business', connected_via: 'coexistence',
      business_account_id: 'w', app_id: 'a', display_phone: '+35315741872', source: 'coexistence',
      is_default: false, is_active: true, created_at: 'c', updated_at: 'u',
    })
    expect(shaped.coex_link_status).toBe('offboarded')
    expect(shaped.coex_offboarded_at).toBe('2026-07-31T10:00:00.000Z')
    expect(JSON.stringify(shaped)).not.toContain('654321')
    expect(JSON.stringify(shaped)).not.toContain('EAAcoexSECRETtoken00')
  })
})
