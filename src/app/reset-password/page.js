'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { passwordRequirements, validatePasswordComplexity } from '@/lib/schemas'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  // Whether this visit is from a fresh invite (no prior sign-ins) vs a
  // recovery flow (existing user resetting). Detected from the URL hash
  // type that Supabase adds to its emailed links: `#type=invite` for
  // inviteUserByEmail, `#type=recovery` for resetPasswordForEmail.
  // Falls back to 'recovery' framing — the safer default if detection
  // ever fails (a user resetting an existing password sees the right
  // wording; an invitee sees slightly off but functional wording).
  const [flowType, setFlowType] = useState('recovery')
  const [branding, setBranding] = useState(null)
  const router = useRouter()

  useEffect(() => {
    fetch('/api/public/branding')
      .then(r => r.json())
      .then(data => { if (data.success && data.data) setBranding(data.data) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    // Two URL shapes Supabase issues for password-reset / invite links:
    //
    //   Legacy (implicit / hash-fragment):
    //     /reset-password#access_token=...&refresh_token=...&type=recovery
    //     The Supabase JS client auto-parses this on page load and fires
    //     PASSWORD_RECOVERY (or SIGNED_IN for invites).
    //
    //   Newer (PKCE / query string):
    //     /reset-password?code=<one_time_code>&type=recovery
    //     Must call supabase.auth.exchangeCodeForSession(code) explicitly.
    //
    // ──────────────────────────────────────────────────────────────────
    // CRITICAL SECURITY BUG fixed 2026-05-13 (CVE-internal):
    //
    // If an operator opens a reset link in a browser tab where they're
    // ALREADY signed in as a different user, the previous code path:
    //   1. onAuthStateChange fires SIGNED_IN for the EXISTING (wrong)
    //      session immediately on mount → setReady(true) → form unlocks
    //   2. The operator submits supabase.auth.updateUser({ password })
    //   3. That call targets the CURRENTLY authenticated user — i.e.
    //      the WRONG account
    //   4. The password of the existing session's user (master,
    //      typically) gets rewritten with the value the operator
    //      intended for the recovery-link target user.
    //
    // Reproduced on 2026-05-13: master account password got hijacked
    // when a master clicked a reset link for a test user while still
    // signed in.
    //
    // Mitigation: ALWAYS sign out any existing session before processing
    // a recovery link. Force a clean slate so updateUser() can only ever
    // target the user whose recovery code we're about to exchange.
    // ──────────────────────────────────────────────────────────────────
    if (typeof window === 'undefined') return

    const hashParams   = new URLSearchParams((window.location.hash || '').replace(/^#/, ''))
    const searchParams = new URLSearchParams(window.location.search || '')
    const t = hashParams.get('type') || searchParams.get('type')
    if (t === 'invite') setFlowType('invite')
    else if (t === 'recovery') setFlowType('recovery')

    const code = searchParams.get('code')
    const hasHashToken = !!(hashParams.get('access_token') || hashParams.get('refresh_token'))
    const isRecoveryLink = !!code || hasHashToken || t === 'recovery' || t === 'invite'

    const supabase = createBrowserClient()
    let cancelled = false

    // Set up the auth listener BEFORE the sign-out. We only listen for
    // PASSWORD_RECOVERY (true recovery flow) and SIGNED_IN (invite-magic
    // flow). Both fire AFTER the sign-out + exchange below, so a stray
    // pre-mount session can't trigger them.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (cancelled) return
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setReady(true)
      }
    })

    ;(async () => {
      try {
        // 1. Force sign-out of any existing session in the browser
        //    BEFORE we process the recovery token. This is the heart of
        //    the fix — without it, updateUser() can hit the wrong user.
        //    Scope 'local' only clears this browser; it doesn't invalidate
        //    the server-side session for a real user who's already logged
        //    in on another device. The reset link itself is what gives
        //    us authority to set the target user's password.
        if (isRecoveryLink) {
          try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* ignore */ }
        }
        if (cancelled) return

        // 2. Exchange the recovery code (PKCE path).
        if (code) {
          const { data, error: exchErr } = await supabase.auth.exchangeCodeForSession(code)
          if (cancelled) return
          if (exchErr) {
            setError(`Reset link could not be verified: ${exchErr.message}. Request a fresh link from the login page.`)
            return
          }
          if (data?.session) setReady(true)
          return
        }

        // 3. Legacy hash-fragment path. After the sign-out above, the
        //    Supabase client should re-parse the URL hash and establish
        //    the recovery session. Confirm via getSession().
        const { data: sessData } = await supabase.auth.getSession()
        if (cancelled) return
        if (sessData?.session) setReady(true)
      } catch (e) {
        if (!cancelled) {
          setError(`Reset link could not be verified: ${e?.message || 'unknown error'}. Request a fresh link from the login page.`)
        }
      }
    })()

    return () => {
      cancelled = true
      sub?.subscription?.unsubscribe?.()
    }
  }, [])

  async function handleReset(e) {
    e.preventDefault()
    setError(null)

    // Mirror the same rules the Supabase Auth dashboard enforces — surface
    // the missing rule before round-tripping rather than after Supabase
    // bounces the update with a generic "weak_password" error.
    const pwError = validatePasswordComplexity(password)
    if (pwError) { setError(pwError); return }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    const supabase = createBrowserClient()

    // Defence-in-depth (CVE-internal 2026-05-13): refuse the update
    // unless we're confident the active session was established by
    // the recovery / invite flow we just processed in useEffect. The
    // `ready` flag is set to true by either:
    //   - exchangeCodeForSession() resolving successfully (PKCE path)
    //   - PASSWORD_RECOVERY auth event (legacy hash path)
    //   - SIGNED_IN event after the forced sign-out (invite path)
    // All three only fire AFTER the existing-session sign-out, so a
    // stale master session can't reach updateUser. Belt-and-braces:
    // if !ready, refuse.
    if (!ready) {
      setError('Reset link not verified yet. Wait a moment and try again, or request a fresh link.')
      setLoading(false)
      return
    }

    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      // AUDIT-EXPAND.1 — record the reset-link password change.
      // Fire-and-forget so the redirect isn't blocked. surface='reset'
      // disambiguates this path from the in-app /account flow.
      try {
        fetch('/api/auth/log-event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'auth.password_changed', surface: 'reset' }),
          keepalive: true,
        }).catch(() => {})
      } catch { /* ignore */ }
      router.push('/')
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen bg-un1t-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={branding.company_name || 'Logo'} className="h-10 mx-auto object-contain" />
          ) : (
            <h1 className="text-3xl font-bold tracking-wider text-un1t-text">{branding?.company_name || 'UN1T'}</h1>
          )}
          <p className="text-sm text-gray-500 mt-1">Lead Management</p>
        </div>

        <form onSubmit={handleReset} className="bg-un1t-surface border border-un1t-border rounded-lg p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-un1t-text mb-1">
              {flowType === 'invite' ? 'Welcome — set your password' : 'Set a new password'}
            </h2>
            <p className="text-xs text-un1t-subtle">
              {flowType === 'invite'
                ? 'Pick a password for your account. You\'ll use this with your email to sign in from now on.'
                : 'Enter your new password below.'}
            </p>
          </div>

          {!ready && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs rounded-md p-3">
              {flowType === 'invite'
                ? 'Verifying your invitation… If this persists, ask the person who invited you to send a fresh link.'
                : 'Verifying your reset link… If this persists, request a new link from the login page.'}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-un1t-subtle mb-1.5">New Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              placeholder="Strong password"
            />
            <ul className="mt-2 space-y-1">
              {passwordRequirements.map(r => {
                const ok = r.test(password || '')
                return (
                  <li key={r.id} className={`flex items-center gap-2 text-xs ${ok ? 'text-green-400' : 'text-un1t-muted'}`}>
                    {ok ? <Check size={12} /> : <X size={12} />}
                    <span>{r.label}</span>
                  </li>
                )
              })}
            </ul>
          </div>

          <div>
            <label className="block text-xs font-medium text-un1t-subtle mb-1.5">Confirm Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              placeholder="Confirm your password"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !ready}
            className="w-full bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            {loading
              ? (flowType === 'invite' ? 'Setting…' : 'Updating…')
              : (flowType === 'invite' ? 'Set Password & Sign In' : 'Update Password')}
          </button>
        </form>

        <p className="text-center text-xs text-un1t-muted mt-6">UN1T CRM v1.0</p>
      </div>
    </div>
  )
}
