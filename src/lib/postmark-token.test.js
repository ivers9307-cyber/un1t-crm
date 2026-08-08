// The single source of truth for the Postmark server token.
//
// Prod regression 2026-08-02: Vercel has POSTMARK_SERVER_TOKEN but not
// POSTMARK_API_KEY. src/lib/postmark.js already fell back between the
// two, but contractor-invoice-email.js and the three xero/* email libs
// each read POSTMARK_API_KEY directly — so campaign email worked while
// the invoice-approval email (and the Xero bill forwards) threw
// "POSTMARK_API_KEY is not configured." Every sender must resolve the
// token through this one helper so the fallback can't drift again.

import { describe, it, expect, afterEach, vi } from 'vitest'

import { resolvePostmarkToken } from './postmark-token.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolvePostmarkToken', () => {
  it('returns POSTMARK_API_KEY when set', () => {
    vi.stubEnv('POSTMARK_API_KEY', 'api-key-token')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    expect(resolvePostmarkToken()).toBe('api-key-token')
  })

  it('falls back to POSTMARK_SERVER_TOKEN when POSTMARK_API_KEY is unset', () => {
    vi.stubEnv('POSTMARK_API_KEY', '')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'server-token')
    expect(resolvePostmarkToken()).toBe('server-token')
  })

  it('prefers POSTMARK_API_KEY when both are set', () => {
    vi.stubEnv('POSTMARK_API_KEY', 'api-key-token')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'server-token')
    expect(resolvePostmarkToken()).toBe('api-key-token')
  })

  it('returns null when neither is set', () => {
    vi.stubEnv('POSTMARK_API_KEY', '')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    expect(resolvePostmarkToken()).toBe(null)
  })
})
