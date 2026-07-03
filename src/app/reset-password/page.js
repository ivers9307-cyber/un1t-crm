'use client'

import { useState, useEffect, useRef } from 'react'
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
  // The client that holds the recovery session must be reused by
  // handleReset — a fresh createBrowserClient() instance would race the
  // cookie write and updateUser() could see no session.
  const supabaseRef = useRef(null)
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
    // ALREADY signed in as a different user, updateUser() could target the
    // CURRENTLY authenticated (wrong) account. Mitigation: ALWAYS sign out
    // any existing session FIRST, then establish ONLY the recovery session
    // from the link, so updateUser() can only ever hit the recovery user.
    //
    // BUG fixed 2026-06: with the auto-detecting client (the @supabase/ssr
    // default `detectSessionInUrl: true`), the client established the
    // recovery session on mount and fired PASSWORD_RECOVERY → the form
    // unlocked — and then the forced sign-out below DESTROYED that very
    // session. Result: the button was enabled but there was no session, so
    // updateUser() failed with "Auth session missing!". Fix: create the
    // client with detectSessionInUrl:false and establish the session
    // ourselves — sign out first, THEN deterministically verify the token,
    // and only unlock the form once getSession() confirms a real session.
    // ──────────────────────────────────────────────────────────────────
    if (typeof window === 'undefined') return

    const hashParams   = new URLSearchParams((window.location.hash || '').replace(/^#/, ''))
    const searchParams = new URLSearchParams(window.location.search || '')
    const t = hashParams.get('type') || searchParams.get('type')
    if (t === 'invite') setFlowType('invite')
    else if (t === 'recovery') setFlowType('recovery')

    // Every token shape Supabase may put on a recovery / invite link:
    //   PKCE query:   ?code=<one_time_code>
    //   token_hash:   ?token_hash=<hash>&type=recovery   (device-independent)
    //   implicit hash:#access_token=...&refresh_token=...&type=recovery
    const code         = searchParams.get('code')
    const tokenHash    = searchParams.get('token_hash') || hashParams.get('token_hash')
    const accessToken  = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')

    const supabase = createBrowserClient({ auth: { detectSessionInUrl: false } })
    supabaseRef.current = supabase
    let cancelled = false

    ;(async () => {
      try {
        // 1. Clean slate — clear any existing browser session BEFORE we
        //    establish the recovery one. Scope 'local' only affects this
        //    browser; it doesn't sign the real user out elsewhere.
        try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* ignore */ }
        if (cancelled) return

        // 2. Establish the recovery session from the link's token.
        if (code) {
          const { error: exErr } = await supabase.auth.exchangeCodeForSession(code)
          if (exErr) throw exErr
        } else if (accessToken && refreshToken) {
          const { error: ssErr } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          if (ssErr) throw ssErr
        } else if (tokenHash) {
          const { error: otpErr } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: t === 'invite' ? 'invite' : 'recovery',
          })
          if (otpErr) throw otpErr
        } else {
          throw new Error('this link is missing its verification token')
        }
        if (cancelled) return

        // 3. Only unlock the form once a real session is confirmed.
        const { data: sessData } = await supabase.auth.getSession()
        if (cancelled) return
        if (sessData?.session) setReady(true)
        else throw new Error('no session was established')
      } catch (e) {
        if (!cancelled) {
          setError(`Reset link could not be verified: ${e?.message || 'unknown error'}. Request a fresh link from the login page.`)
        }
      }
    })()

    return () => { cancelled = true }
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

    // Reuse the exact client that holds the recovery session (set up in
    // useEffect) — a fresh instance could miss the just-written session.
    const supabase = supabaseRef.current

    // Defence-in-depth (CVE-internal 2026-05-13): refuse the update unless
    // the recovery session was established by the flow processed in
    // useEffect. `ready` is only set true after getSession() confirms a
    // real session that followed the forced sign-out, so a stale session
    // can't reach updateUser.
    if (!ready || !supabase) {
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
            <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 text-xs rounded-md p-3">
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
            <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-3">
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
