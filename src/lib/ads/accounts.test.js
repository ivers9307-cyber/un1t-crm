// src/lib/ads/accounts.test.js
import { describe, it, expect } from 'vitest'
import { maskSecret, maskAccountRow, isFreshSecret, buildAccountPatch } from './accounts.js'
import { SECRET_MASK } from '../secret-keys.js'

describe('maskSecret (N8NECHO.1: presence only)', () => {
  it('a stored token is the shared mask, with no character of it', () => {
    expect(maskSecret('EAAB1234secrettoken')).toBe(SECRET_MASK)
    expect(maskSecret('EAAB1234secrettoken')).not.toMatch(/oken/)
  })
  it('nothing stored is an empty string (has_access_token carries presence)', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret(null)).toBe('')
  })
})

describe('isFreshSecret (the shared •• rule)', () => {
  it('no mask shape is ever fresh: the new one, the old 8-bullet one, the old WhatsApp one', () => {
    expect(isFreshSecret(SECRET_MASK)).toBe(false)
    expect(isFreshSecret('••••••••oken')).toBe(false)
    expect(isFreshSecret('••••abcdef')).toBe(false)
  })
  it('blank is not fresh; a real token is', () => {
    expect(isFreshSecret('')).toBe(false)
    expect(isFreshSecret('   ')).toBe(false)
    expect(isFreshSecret(null)).toBe(false)
    expect(isFreshSecret('EAAB1234newtoken')).toBe(true)
  })
  it('THE TRAP: a PUT echoing SECRET_MASK builds a patch without access_token', () => {
    expect(buildAccountPatch({ access_token: SECRET_MASK, display_name: 'Ads' })).toEqual({ display_name: 'Ads' })
  })
  it('round-trip: the mask maskAccountRow hands the screen, sent back, is never a patch value', () => {
    const shown = maskAccountRow({ id: '1', provider: 'meta', access_token: 'SYNTH-ADS-TOKEN-9999' })
    expect(buildAccountPatch({ access_token: shown.access_token })).toEqual({})
  })
})

describe('maskAccountRow', () => {
  it('masks the token and adds has_access_token', () => {
    const out = maskAccountRow({ id: '1', provider: 'meta', access_token: 'EAABsecrettok', external_account_id: '900' })
    expect(out.access_token).toBe(SECRET_MASK)
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
  it('stores a pasted token trimmed (a stray space or newline would break every ads call)', () => {
    const patch = buildAccountPatch({ access_token: '  SYNTH-ADS-TOKEN-PASTED\n' })
    expect(patch.access_token).toBe('SYNTH-ADS-TOKEN-PASTED')
  })
})
