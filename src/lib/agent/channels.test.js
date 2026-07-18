// RADAR-AGENT.0b — unit tests for channel connection pure helpers.
import { describe, it, expect } from 'vitest'
import {
  maskSecret,
  isFreshSecret,
  maskConnectionRow,
  buildConnectionPatch,
  SUPPORTED_PLATFORMS,
  isAgentEnabledForConnection,
  buildTokenRefreshPatch,
} from './channels'

describe('maskSecret', () => {
  it('masks long secrets keeping the tail', () => {
    expect(maskSecret('EAAB1234567890abcdef')).toBe('••••••abcdef')
  })
  it('fully masks short secrets', () => {
    expect(maskSecret('abc')).toBe('••••••')
  })
  it('returns null for empty', () => {
    expect(maskSecret('')).toBeNull()
    expect(maskSecret(null)).toBeNull()
  })
})

describe('isFreshSecret', () => {
  it('rejects blank and masked echoes', () => {
    expect(isFreshSecret('')).toBe(false)
    expect(isFreshSecret('   ')).toBe(false)
    expect(isFreshSecret('••••••abcdef')).toBe(false)
    expect(isFreshSecret(null)).toBe(false)
  })
  it('accepts a real new value', () => {
    expect(isFreshSecret('EAAB-real-token')).toBe(true)
  })
})

describe('maskConnectionRow', () => {
  it('masks every secret field and adds has_ flags', () => {
    const row = {
      id: '1', platform: 'instagram', access_token: 'tok-1234567890', app_secret: null, page_id: 'P1',
    }
    const out = maskConnectionRow(row)
    expect(out.access_token).toBe('••••••567890')
    expect(out.has_access_token).toBe(true)
    expect(out.app_secret).toBeNull()
    expect(out.has_app_secret).toBe(false)
    expect(out.page_id).toBe('P1') // non-secret untouched
  })
})

describe('buildConnectionPatch', () => {
  it('copies non-secret fields when present', () => {
    const p = buildConnectionPatch({ platform: 'instagram', page_id: 'P1', label: 'Stillorgan IG' })
    expect(p).toEqual({ platform: 'instagram', page_id: 'P1', label: 'Stillorgan IG' })
  })
  it('omits secrets that are blank or masked echoes', () => {
    const p = buildConnectionPatch({ access_token: '••••••567890', app_secret: '' })
    expect(p.access_token).toBeUndefined()
    expect(p.app_secret).toBeUndefined()
  })
  it('includes secrets only when fresh, trimmed', () => {
    const p = buildConnectionPatch({ access_token: '  EAAB-new  ' })
    expect(p.access_token).toBe('EAAB-new')
  })
  it('ignores unknown fields', () => {
    const p = buildConnectionPatch({ hacker: 'x', is_active: false })
    expect(p.hacker).toBeUndefined()
    expect(p.is_active).toBe(false)
  })
  it('passes agent_enabled through the default fields', () => {
    const p = buildConnectionPatch({ agent_enabled: true })
    expect(p.agent_enabled).toBe(true)
  })
})

describe('SUPPORTED_PLATFORMS', () => {
  it('covers instagram + messenger', () => {
    expect(SUPPORTED_PLATFORMS).toContain('instagram')
    expect(SUPPORTED_PLATFORMS).toContain('messenger')
  })
})

describe('isAgentEnabledForConnection', () => {
  it('null/undefined connection → false (default closed)', () => {
    expect(isAgentEnabledForConnection(null)).toBe(false)
    expect(isAgentEnabledForConnection(undefined)).toBe(false)
  })
  it('agent_enabled false or missing → false', () => {
    expect(isAgentEnabledForConnection({})).toBe(false)
    expect(isAgentEnabledForConnection({ agent_enabled: false })).toBe(false)
  })
  it('agent_enabled true → true', () => {
    expect(isAgentEnabledForConnection({ agent_enabled: true })).toBe(true)
  })
})

describe('buildTokenRefreshPatch', () => {
  const NOW = new Date('2026-07-18T12:00:00Z')
  it('valid refresh response → token + refreshed_at + expires_at', () => {
    const p = buildTokenRefreshPatch({ access_token: 'IGAAX-new', token_type: 'bearer', expires_in: 5184000 }, NOW)
    expect(p.access_token).toBe('IGAAX-new')
    expect(p.token_refreshed_at).toBe('2026-07-18T12:00:00.000Z')
    expect(p.token_expires_at).toBe(new Date(NOW.getTime() + 5184000 * 1000).toISOString())
  })
  it('missing/empty token → null (never clobber a stored token)', () => {
    expect(buildTokenRefreshPatch(null, NOW)).toBe(null)
    expect(buildTokenRefreshPatch({}, NOW)).toBe(null)
    expect(buildTokenRefreshPatch({ access_token: '' }, NOW)).toBe(null)
    expect(buildTokenRefreshPatch({ error: { message: 'expired' } }, NOW)).toBe(null)
  })
  it('unparseable expires_in → token saved, expires_at null', () => {
    const p = buildTokenRefreshPatch({ access_token: 'IGAAX-new', expires_in: 'soon' }, NOW)
    expect(p.access_token).toBe('IGAAX-new')
    expect(p.token_expires_at).toBe(null)
  })
})
