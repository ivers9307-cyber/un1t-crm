'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { passwordRequirements, validatePasswordComplexity } from '@/lib/schemas'
import { parseRecoveryLink, establishRecoverySession } from '@/lib/recovery-link'

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
  // The user id the link verified as. handleReset re-checks the live session
  // against it so the password change can only ever land on that account.
  const linkUserRef = useRef(null)
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
    // CURRENTLY authenticated (wrong) account.
    //
    // BUG fixed 2026-06: with the auto-detecting client (the @supabase/ssr
    // default `detectSessionInUrl: true`), the client established the
    // recovery session on mount and fired PASSWORD_RECOVERY → the form
    // unlocked — and then a forced sign-out DESTROYED that very session.
    // Hence detectSessionInUrl:false and an explicit handshake here.
    //
    // BUG fixed 2026-07-31 (RESET-PKCE.1): that handshake signed out BEFORE
    // exchanging the code, and auth-js `_removeSession()` deletes the PKCE
    // code verifier alongside the session — so the exchange on the next line
    // could never succeed. The order now lives in `establishRecoverySession`
    // (session first, sign out only on failure); see that module's header.
    // ──────────────────────────────────────────────────────────────────
    if (typeof window === 'undefined') return

    const link = parseRecoveryLink({
      hash: window.location.hash,
      search: window.location.search,
    })
    setFlowType(link.flowType)

    const supabase = createBrowserClient({ auth: { detectSessionInUrl: false } })
    supabaseRef.current = supabase
    let cancelled = false

    ;(async () => {
      try {
        const { userId } = await establishRecoverySession(supabase, link)
        if (cancelled) return
        linkUserRef.current = userId
        setReady(true)
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Reset link could not be verified.')
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
    // useEffect. `ready` is only set true once the link's token minted a
    // session AND getUser() confirmed it belongs to the link's account.
    if (!ready || !supabase) {
      setError('Reset link not verified yet. Wait a moment and try again, or request a fresh link.')
      setLoading(false)
      return
    }

    // …and re-check at the moment of the write that the live session is
    // still that same account, so the password can never land on a session
    // that appeared (another tab signing in) after verification.
    const { data: live } = await supabase.auth.getUser()
    if (!live?.user || live.user.id !== linkUserRef.current) {
      setError('This session no longer matches the reset link. Request a fresh link from the login page.')
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

          {/* Once the link has failed, the "verifying…" banner is a lie —
              only show it while the handshake is still in flight. */}
          {!ready && !error && (
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
