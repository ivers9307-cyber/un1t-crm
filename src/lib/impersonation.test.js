// Header / cookie reader tests for the impersonation helpers. These
// pure-ish functions back the master "View as user" feature on both
// web (cookie path) and mobile (header path); a wrong UUID regex or
// the wrong combination order would silently break the feature on
// one platform without breaking the other, so pin both explicitly.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// next/headers must be mocked because the helpers call it
// synchronously. Each test reaches in and sets the underlying maps.
const cookieMap = new Map()
const headerMap = new Map()

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name) => (cookieMap.has(name) ? { value: cookieMap.get(name) } : undefined),
    set: () => {},
  }),
  headers: () => ({
    get: (name) => headerMap.get(name.toLowerCase()) ?? null,
  }),
}))

const VALID = 'c6ab85ca-2e35-4aca-b65c-6407294bb1ed'

describe('readImpersonationCookie', () => {
  beforeEach(() => {
    cookieMap.clear()
    headerMap.clear()
  })

  it('returns null when no cookie is set', async () => {
    const { readImpersonationCookie } = await import('./impersonation.js')
    expect(await readImpersonationCookie()).toBe(null)
  })

  it('returns the value when it is a UUID', async () => {
    cookieMap.set('un1t_impersonate', VALID)
    const { readImpersonationCookie } = await import('./impersonation.js')
    expect(await readImpersonationCookie()).toBe(VALID)
  })

  it('rejects non-UUID values (defence-in-depth — the cookie is httpOnly, but trust nothing)', async () => {
    cookieMap.set('un1t_impersonate', 'not-a-uuid')
    const { readImpersonationCookie } = await import('./impersonation.js')
    expect(await readImpersonationCookie()).toBe(null)
  })
})

describe('readImpersonationHeader', () => {
  beforeEach(() => {
    cookieMap.clear()
    headerMap.clear()
  })

  it('returns null when no header is set', async () => {
    const { readImpersonationHeader } = await import('./impersonation.js')
    expect(await readImpersonationHeader()).toBe(null)
  })

  it('returns the value when x-impersonate-target is a UUID', async () => {
    headerMap.set('x-impersonate-target', VALID)
    const { readImpersonationHeader } = await import('./impersonation.js')
    expect(await readImpersonationHeader()).toBe(VALID)
  })

  it('rejects non-UUID header values', async () => {
    headerMap.set('x-impersonate-target', 'malicious; DROP TABLE')
    const { readImpersonationHeader } = await import('./impersonation.js')
    expect(await readImpersonationHeader()).toBe(null)
  })
})

describe('readImpersonationTarget (combined)', () => {
  beforeEach(() => {
    cookieMap.clear()
    headerMap.clear()
  })

  it('prefers the header over the cookie when both are set', async () => {
    const HEADER_TARGET = '11111111-1111-1111-1111-111111111111'
    const COOKIE_TARGET = '22222222-2222-2222-2222-222222222222'
    cookieMap.set('un1t_impersonate', COOKIE_TARGET)
    headerMap.set('x-impersonate-target', HEADER_TARGET)
    const { readImpersonationTarget } = await import('./impersonation.js')
    expect(await readImpersonationTarget()).toBe(HEADER_TARGET)
  })

  it('falls back to the cookie when the header is missing', async () => {
    cookieMap.set('un1t_impersonate', VALID)
    const { readImpersonationTarget } = await import('./impersonation.js')
    expect(await readImpersonationTarget()).toBe(VALID)
  })

  it('returns null when both are absent', async () => {
    const { readImpersonationTarget } = await import('./impersonation.js')
    expect(await readImpersonationTarget()).toBe(null)
  })
})
