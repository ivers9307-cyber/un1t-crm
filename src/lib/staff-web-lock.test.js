// STAFF-WEB-LOCK — unit tests for the pure staff browser-lockout decision.
//
// The proxy consults decideStaffWebLock() after resolving a Supabase user
// for a non-public page request. It must:
//   - stay completely inert unless STAFF_WEB_LOCK=1 (enabled flag)
//   - never wall a studio device (studio_session cookie present) — PIN
//     tablets and the Mac front-desk shell are browser surfaces by design
//   - never wall /api/* (the mobile app and every integration), the wall
//     page itself, /live displays, or the auth routes a walled user still
//     needs (/login, /auth/callback, /reset-password)
//   - match exemptions by SEGMENT, not raw prefix
//   - wall everything else to /use-the-app

import { describe, it, expect } from 'vitest'
import {
  decideStaffWebLock,
  STAFF_WEB_LOCK_PATH,
  STUDIO_SESSION_COOKIE,
} from './staff-web-lock.js'
import { COOKIE_NAME as STUDIO_COOKIE_CANONICAL } from './studio-session.js'

function decide(overrides = {}) {
  return decideStaffWebLock({
    enabled: true,
    pathname: '/dashboard',
    hasStudioSession: false,
    ...overrides,
  })
}

describe('decideStaffWebLock', () => {
  it('is inert when the flag is off', () => {
    expect(decide({ enabled: false })).toBeNull()
    expect(decide({ enabled: undefined })).toBeNull()
  })

  it('walls an authenticated page request when enabled', () => {
    expect(decide()).toEqual({ redirect: STAFF_WEB_LOCK_PATH })
    expect(decide({ pathname: '/' })).toEqual({ redirect: STAFF_WEB_LOCK_PATH })
    expect(decide({ pathname: '/communications/sequences/abc' })).toEqual({
      redirect: STAFF_WEB_LOCK_PATH,
    })
  })

  it('never walls a studio device session', () => {
    expect(decide({ hasStudioSession: true })).toBeNull()
    expect(decide({ hasStudioSession: true, pathname: '/' })).toBeNull()
  })

  it('never walls /api/*', () => {
    expect(decide({ pathname: '/api/contacts' })).toBeNull()
    expect(decide({ pathname: '/api/admin/fleet/devices' })).toBeNull()
  })

  it('never walls the wall page itself', () => {
    expect(decide({ pathname: STAFF_WEB_LOCK_PATH })).toBeNull()
  })

  it('never walls studio display or auth surfaces', () => {
    for (const p of ['/live', '/live/loc-1', '/login', '/auth/callback', '/reset-password', '/reset-password/done']) {
      expect(decide({ pathname: p })).toBeNull()
    }
  })

  it('matches exemptions by segment, not raw prefix', () => {
    expect(decide({ pathname: '/use-the-appliance' })).toEqual({
      redirect: STAFF_WEB_LOCK_PATH,
    })
    expect(decide({ pathname: '/livestock' })).toEqual({
      redirect: STAFF_WEB_LOCK_PATH,
    })
    expect(decide({ pathname: '/reset-password-info' })).toEqual({
      redirect: STAFF_WEB_LOCK_PATH,
    })
  })

  it('keeps the duplicated studio cookie name in sync with studio-session.js', () => {
    // staff-web-lock.js cannot import studio-session.js (node:crypto is not
    // edge-safe), so the cookie name is duplicated there. This is the tripwire.
    expect(STUDIO_SESSION_COOKIE).toBe(STUDIO_COOKIE_CANONICAL)
  })
})
