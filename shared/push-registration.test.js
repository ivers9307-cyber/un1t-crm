import { describe, it, expect } from 'vitest'
import { shouldRegisterPush, isGenuinePushSuccess } from './push-registration.js'

describe('isGenuinePushSuccess', () => {
  it('is false for null / non-object', () => {
    expect(isGenuinePushSuccess(null)).toBe(false)
    expect(isGenuinePushSuccess(undefined)).toBe(false)
    expect(isGenuinePushSuccess('nope')).toBe(false)
  })

  it('is false for any skipped result', () => {
    expect(isGenuinePushSuccess({ skipped: true, reason: 'simulator' })).toBe(false)
    expect(isGenuinePushSuccess({ skipped: true, reason: 'permission_denied' })).toBe(false)
    expect(isGenuinePushSuccess({ skipped: true, reason: 'no_token' })).toBe(false)
    expect(isGenuinePushSuccess({ skipped: true, reason: 'token_error: boom' })).toBe(false)
  })

  it('is false when a token was returned but the server POST failed', () => {
    expect(isGenuinePushSuccess({ token: 'ExpoTok', result: { success: false, error: 'HTTP 500' } })).toBe(false)
  })

  it('is true when a token was returned and the server POST succeeded', () => {
    expect(isGenuinePushSuccess({ token: 'ExpoTok', result: { success: true } })).toBe(true)
    expect(isGenuinePushSuccess({ token: 'ExpoTok', result: { ok: true } })).toBe(true)
  })
})

describe('shouldRegisterPush', () => {
  const granted = { optedOut: false, permission: 'granted', lastResult: null }

  it('attempts on a fresh granted launch that has not registered yet', () => {
    expect(shouldRegisterPush(granted)).toBe(true)
  })

  it('never attempts when the member opted out (even if permission granted)', () => {
    expect(shouldRegisterPush({ ...granted, optedOut: true })).toBe(false)
  })

  it('does not attempt when OS permission is not granted', () => {
    expect(shouldRegisterPush({ ...granted, permission: 'denied' })).toBe(false)
    expect(shouldRegisterPush({ ...granted, permission: 'undetermined' })).toBe(false)
  })

  it('does not re-attempt after a genuine success (latched)', () => {
    expect(shouldRegisterPush({ ...granted, lastResult: { token: 'T', result: { success: true } } })).toBe(false)
  })

  it('DOES re-attempt after a transient failure (permission_denied skip or failed POST)', () => {
    expect(shouldRegisterPush({ ...granted, lastResult: { skipped: true, reason: 'permission_denied' } })).toBe(true)
    expect(shouldRegisterPush({ ...granted, lastResult: { token: 'T', result: { success: false, error: 'x' } } })).toBe(true)
  })

  it('tolerates being called with no args', () => {
    expect(shouldRegisterPush()).toBe(false)
  })
})
