// RESET-PKCE.1 — regression tests for the recovery/invite link handshake.
//
// The bug these lock down (prod, 2026-07-31): /reset-password called
// `signOut({ scope: 'local' })` BEFORE `exchangeCodeForSession(code)`.
// auth-js `_removeSession()` deletes `${storageKey}-code-verifier` along
// with the session, so the sign-out destroyed the PKCE verifier the very
// next line needed. Every `?code=` reset link died with
// AuthPKCECodeVerifierMissingError, and re-clicking the (now consumed)
// link showed the misleading "missing its verification token" banner.

import { describe, it, expect, vi } from 'vitest'
import { parseRecoveryLink, establishRecoverySession, RecoveryLinkError } from './recovery-link.js'

// A fake Supabase auth client that models the two real behaviours that
// matter here:
//   1. signOut() wipes the stored PKCE code verifier (auth-js does this).
//   2. exchangeCodeForSession() fails when the verifier is gone.
function fakeClient({ verifier = 'v3rif13r', user = { id: 'user-1' }, exchangeError = null } = {}) {
  const calls = []
  const store = { verifier }
  return {
    calls,
    auth: {
      signOut: vi.fn(async () => {
        calls.push('signOut')
        store.verifier = null // auth-js _removeSession() removes -code-verifier
        return { error: null }
      }),
      exchangeCodeForSession: vi.fn(async (code) => {
        calls.push(`exchange:${code}`)
        if (exchangeError) return { data: null, error: exchangeError }
        if (!store.verifier) {
          return {
            data: null,
            error: Object.assign(new Error('PKCE code verifier not found in storage.'), {
              code: 'pkce_code_verifier_not_found',
              name: 'AuthPKCECodeVerifierMissingError',
            }),
          }
        }
        return { data: { user, session: { access_token: 'a' } }, error: null }
      }),
      setSession: vi.fn(async () => {
        calls.push('setSession')
        return { data: { user, session: { access_token: 'a' } }, error: null }
      }),
      verifyOtp: vi.fn(async () => {
        calls.push('verifyOtp')
        return { data: { user, session: { access_token: 'a' } }, error: null }
      }),
      getUser: vi.fn(async () => {
        calls.push('getUser')
        return { data: { user }, error: null }
      }),
    },
  }
}

describe('parseRecoveryLink', () => {
  it('reads a PKCE code from the query string', () => {
    const link = parseRecoveryLink({ search: '?code=abc123', hash: '' })
    expect(link.code).toBe('abc123')
    expect(link.flowType).toBe('recovery')
    expect(link.errorCode).toBeNull()
  })

  it('reads implicit access/refresh tokens from the hash', () => {
    const link = parseRecoveryLink({
      hash: '#access_token=at&refresh_token=rt&type=recovery',
      search: '',
    })
    expect(link.accessToken).toBe('at')
    expect(link.refreshToken).toBe('rt')
  })

  it('reads a token_hash from either query or hash', () => {
    expect(parseRecoveryLink({ search: '?token_hash=th&type=recovery' }).tokenHash).toBe('th')
    expect(parseRecoveryLink({ hash: '#token_hash=th&type=invite' }).tokenHash).toBe('th')
  })

  it('detects the invite flow from either location', () => {
    expect(parseRecoveryLink({ hash: '#type=invite' }).flowType).toBe('invite')
    expect(parseRecoveryLink({ search: '?type=invite' }).flowType).toBe('invite')
    expect(parseRecoveryLink({ search: '?type=recovery' }).flowType).toBe('recovery')
    expect(parseRecoveryLink({}).flowType).toBe('recovery') // safe default
  })

  // The screenshot case: GoTrue bounces an expired/consumed link back with
  // its error in the hash. Before this we read no token and blamed the link
  // for being malformed.
  it('surfaces a GoTrue error returned in the hash', () => {
    const link = parseRecoveryLink({
      hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      search: '',
    })
    expect(link.errorCode).toBe('otp_expired')
    expect(link.errorDescription).toContain('expired')
  })

  it('reports nothing usable on a bare URL', () => {
    const link = parseRecoveryLink({ hash: '', search: '' })
    expect(link.code).toBeNull()
    expect(link.tokenHash).toBeNull()
    expect(link.accessToken).toBeNull()
    expect(link.errorCode).toBeNull()
  })
})

describe('establishRecoverySession', () => {
  // THE regression. If the implementation signs out before exchanging, the
  // fake client loses its verifier and the exchange fails — exactly what
  // prod did.
  it('exchanges the PKCE code WITHOUT signing out first', async () => {
    const c = fakeClient()
    const res = await establishRecoverySession(c, parseRecoveryLink({ search: '?code=abc123' }))
    expect(res.userId).toBe('user-1')
    expect(c.calls[0]).toBe('exchange:abc123')
    expect(c.auth.signOut).not.toHaveBeenCalled()
  })

  it('clears any stale session when the exchange fails, and never reports ready', async () => {
    const c = fakeClient({ exchangeError: Object.assign(new Error('bad code'), { code: 'bad_code' }) })
    await expect(
      establishRecoverySession(c, parseRecoveryLink({ search: '?code=abc123' }))
    ).rejects.toBeInstanceOf(RecoveryLinkError)
    // Defence-in-depth (CVE-internal 2026-05-13): a failed link must not
    // leave a different user's session behind for updateUser() to hit.
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('explains a cross-browser open instead of leaking the SDK message', async () => {
    const c = fakeClient({ verifier: null }) // link opened in a different browser
    await expect(
      establishRecoverySession(c, parseRecoveryLink({ search: '?code=abc123' }))
    ).rejects.toThrow(/same browser/i)
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('says "expired or already used" for an otp_expired bounce, without calling the API', async () => {
    const c = fakeClient()
    const link = parseRecoveryLink({ hash: '#error=access_denied&error_code=otp_expired' })
    await expect(establishRecoverySession(c, link)).rejects.toThrow(/expired or has already been used/i)
    expect(c.auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('still supports the legacy implicit hash link', async () => {
    const c = fakeClient()
    const res = await establishRecoverySession(
      c,
      parseRecoveryLink({ hash: '#access_token=at&refresh_token=rt&type=recovery' })
    )
    expect(res.userId).toBe('user-1')
    expect(c.auth.setSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' })
  })

  it('still supports a token_hash link, with the right OTP type', async () => {
    const c = fakeClient()
    await establishRecoverySession(c, parseRecoveryLink({ search: '?token_hash=th&type=invite' }))
    expect(c.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th', type: 'invite' })
  })

  it('rejects a link carrying no token at all', async () => {
    const c = fakeClient()
    await expect(establishRecoverySession(c, parseRecoveryLink({}))).rejects.toThrow(/missing its verification token/i)
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('refuses to report ready if no user comes back', async () => {
    const c = fakeClient()
    c.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    await expect(
      establishRecoverySession(c, parseRecoveryLink({ search: '?code=abc123' }))
    ).rejects.toBeInstanceOf(RecoveryLinkError)
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('confirms the session belongs to the link user, not a lingering one', async () => {
    const c = fakeClient()
    // A different user is somehow still in storage after the exchange.
    c.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'someone-else' } }, error: null })
    await expect(
      establishRecoverySession(c, parseRecoveryLink({ search: '?code=abc123' }))
    ).rejects.toThrow(/could not be verified/i)
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
