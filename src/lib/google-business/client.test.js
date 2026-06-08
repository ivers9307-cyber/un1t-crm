import { describe, it, expect, beforeEach } from 'vitest'
import { buildAuthorizeUrl, GoogleBusinessError } from './client'

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://crm.test/api/google-business/callback'
})

describe('buildAuthorizeUrl', () => {
  it('includes offline access + consent prompt + business.manage scope', () => {
    const url = new URL(buildAuthorizeUrl({ state: 'nonce.loc' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('business.manage')
    expect(url.searchParams.get('state')).toBe('nonce.loc')
    expect(url.searchParams.get('client_id')).toBe('cid')
  })
})

describe('GoogleBusinessError', () => {
  it('carries status + body', () => {
    const e = new GoogleBusinessError('boom', { status: 401, body: { x: 1 } })
    expect(e.name).toBe('GoogleBusinessError')
    expect(e.status).toBe(401)
  })
})
