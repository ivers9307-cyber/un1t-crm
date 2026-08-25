// PHASE2 stage C — member api sign-out policy. The merged app holds ONE
// session for both shells, so the member fetch helper may self-sign-out
// ONLY on an explicit invalid-refresh-token error from the shared
// client's refresh attempt. A champ-host outage (401 with a
// freshly-refreshed token, 5xx, network error) must degrade the member
// surface only — never end the staff session.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  refreshError: null,
  responses: [],
}))

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { champApiBaseUrl: 'https://champ.test', apiBaseUrl: 'https://crm.test' } } },
}))
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } } })),
      refreshSession: vi.fn(async () => ({ error: state.refreshError })),
      signOut: vi.fn(async () => ({})),
    },
  },
}))
vi.mock('../sign-out', () => ({
  performFullSignOut: vi.fn(async () => {}),
}))

import { api, isInvalidRefreshTokenError, MemberApiError } from './api'
import { supabase } from './supabase'
import { performFullSignOut } from '../sign-out'

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.refreshError = null
  state.responses = []
  global.fetch = vi.fn(async () => {
    const next = state.responses.shift()
    if (next instanceof Error) throw next
    return next
  })
})

describe('isInvalidRefreshTokenError', () => {
  it('matches supabase invalid-refresh-token failures', () => {
    expect(isInvalidRefreshTokenError({ message: 'Invalid Refresh Token: Refresh Token Not Found' })).toBe(true)
    expect(isInvalidRefreshTokenError({ code: 'refresh_token_not_found', message: 'x' })).toBe(true)
    expect(isInvalidRefreshTokenError({ code: 'refresh_token_already_used', message: 'x' })).toBe(true)
  })

  it('rejects host/transport failures and empties', () => {
    expect(isInvalidRefreshTokenError({ message: 'Failed to fetch' })).toBe(false)
    expect(isInvalidRefreshTokenError({ message: 'AuthRetryableFetchError: 503' })).toBe(false)
    expect(isInvalidRefreshTokenError(null)).toBe(false)
    expect(isInvalidRefreshTokenError(undefined)).toBe(false)
  })
})

describe('member api sign-out policy', () => {
  it('401 → refresh ok → retry 200 → success, no sign-out', async () => {
    state.responses = [jsonResponse(401, { success: false }), jsonResponse(200, { success: true, data: { x: 1 } })]
    const r = await api('/api/thing')
    expect(r.success).toBe(true)
    expect(performFullSignOut).not.toHaveBeenCalled()
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
  })

  it('401 → refresh ok → retry STILL 401 → error result, NEVER a sign-out (host-level 401)', async () => {
    state.responses = [jsonResponse(401, { success: false }), jsonResponse(401, { success: false })]
    const r = await api('/api/thing')
    expect(r.success).toBe(false)
    expect(performFullSignOut).not.toHaveBeenCalled()
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
  })

  it('401 → refresh fails with INVALID REFRESH TOKEN → full sign-out teardown, session-expired error', async () => {
    state.refreshError = { code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }
    state.responses = [jsonResponse(401, { success: false })]
    const r = await api('/api/thing')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/session expired/i)
    expect(performFullSignOut).toHaveBeenCalledTimes(1)
  })

  it('401 → refresh fails for any OTHER reason (auth outage) → error result, no sign-out', async () => {
    state.refreshError = { message: 'AuthRetryableFetchError: Failed to fetch' }
    state.responses = [jsonResponse(401, { success: false })]
    const r = await api('/api/thing')
    expect(r.success).toBe(false)
    expect(performFullSignOut).not.toHaveBeenCalled()
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
  })

  it('5xx → error result, no refresh, no sign-out', async () => {
    state.responses = [jsonResponse(503, { success: false, error: 'down' })]
    const r = await api('/api/thing')
    expect(r.success).toBe(false)
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled()
    expect(performFullSignOut).not.toHaveBeenCalled()
  })

  it('network error → error result, no sign-out', async () => {
    state.responses = [new Error('Network request failed')]
    const r = await api('/api/thing')
    expect(r.success).toBe(false)
    expect(performFullSignOut).not.toHaveBeenCalled()
  })

  it('exports a typed MemberApiError for callers that need to throw', () => {
    const e = new MemberApiError('boom', { status: 401, hostLevel: true })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('MemberApiError')
    expect(e.status).toBe(401)
    expect(e.hostLevel).toBe(true)
  })
})
