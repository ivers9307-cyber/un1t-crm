// src/lib/ads/accounts.test.js
import { describe, it, expect } from 'vitest'
import { maskSecret, maskAccountRow, isFreshSecret, buildAccountPatch } from './accounts.js'

describe('maskSecret', () => {
  it('shows only the last 4 chars', () => {
    expect(maskSecret('EAAB1234secrettoken')).toBe('••••••••oken')
  })
  it('returns empty for empty', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret(null)).toBe('')
  })
})

describe('isFreshSecret', () => {
  it('treats a masked echo as not fresh', () => {
    expect(isFreshSecret('••••••••oken')).toBe(false)
  })
  it('treats a real value as fresh', () => {
    expect(isFreshSecret('EAAB1234newtoken')).toBe(true)
    expect(isFreshSecret('')).toBe(false)
  })
})

describe('maskAccountRow', () => {
  it('masks the token and adds has_access_token', () => {
    const out = maskAccountRow({ id: '1', provider: 'meta', access_token: 'EAABsecrettok', external_account_id: '900' })
    expect(out.access_token).toBe('••••••••ttok')
    expect(out.has_access_token).toBe(true)
    expect(out.external_account_id).toBe('900')
  })
  it('handles a missing token', () => {
    const out = maskAccountRow({ id: '1', provider: 'meta', access_token: null })
    expect(out.access_token).toBe('')
    expect(out.has_access_token).toBe(false)
  })
})

describe('buildAccountPatch', () => {
  it('writes a fresh token but ignores a masked echo', () => {
    const patch = buildAccountPatch({ external_account_id: '900', access_token: '••••••••ttok', is_active: true })
    expect(patch.external_account_id).toBe('900')
    expect('access_token' in patch).toBe(false)
    expect(patch.is_active).toBe(true)
  })
  it('writes a real new token', () => {
    const patch = buildAccountPatch({ access_token: 'EAABnewtoken1234' })
    expect(patch.access_token).toBe('EAABnewtoken1234')
  })
})
