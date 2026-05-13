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
    // Two URL shapes Supabase issues for password-reset / invite links,
    // depending on which flow the project is configured for:
    //
    //   Legacy (implicit / hash-fragment):
    //     /reset-password#access_token=...&refresh_token=...&type=recovery
    //     The Supabase JS client auto-parses this on page load and fires
    //     a PASSWORD_RECOVERY (or SIGNED_IN for invites) auth event.
    //
    //   Newer (PKCE / query string):
    //     /reset-password?code=<one_time_code>&type=recovery
    //     The client does NOT auto-exchange this — we must call
    //     supabase.auth.exchangeCodeForSession(code) explicitly. Without
    //     that call the page sits at "Verifying…" forever and the
    //     Update Password button stays disabled. (Dean hit this on
    //     2026-05-13.)
    //
    // We handle both. Detect type from either hash OR search params,
    // and exchange the code if present.
    if (typeof window === 'undefined') return

    const hashParams   = new URLSearchParams((window.location.hash || '').replace(/^#/, ''))
    const searchParams = new URLSearchParams(window.location.search || '')
    const t = hashParams.get('type') || searchParams.get('type')
    if (t === 'invite') setFlowType('invite')
    else if (t === 'recovery') setFlowType('recovery')

    const supabase = createBrowserClient()

    // Recovery + invite both fire onAuthStateChange. PASSWORD_RECOVERY
    // for recovery; SIGNED_IN for invites (magic link signs them in
    // immediately, then they pick a password).
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setReady(true)
      }
    })

    // PKCE path: exchange ?code=... for a session. The auth event
    // fires from inside the exchange, so the listener above handles
    // setReady too. We only setError on hard failure.
    const code = searchParams.get('code')
    if (code) {
      supabase.auth.exchangeCodeForSession(code)
        .then(({ data, error: exchErr }) => {
          if (exchErr) {
            setError(`Reset link could not be verified: ${exchErr.message}. Request a fresh link from the login page.`)
            return
          }
          if (data?.session) setReady(true)
        })
        .catch((e) => {
          setError(`Reset link could not be verified: ${e?.message || 'unknown error'}. Request a fresh link from the login page.`)
        })
    } else {
      // Legacy hash-fragment path: the client auto-exchanges on page
      // load. Either the listener above will fire OR an existing
      // session is already there from a prior render.
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) setReady(true)
      })
    }

    return () => sub?.subscription?.unsubscribe?.()
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
    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen bg-un1t-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={branding.company_name || 'Logo'} className="h-10 mx-auto object-contain" />
          ) : (
            <h1 className="text-3xl font-bold tracking-wider text-un1t-white">{branding?.company_name || 'UN1T'}</h1>
          )}
          <p className="text-sm text-gray-500 mt-1">Lead Management</p>
        </div>

        <form onSubmit={handleReset} className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-un1t-white mb-1">
              {flowType === 'invite' ? 'Welcome — set your password' : 'Set a new password'}
            </h2>
            <p className="text-xs text-un1t-light">
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
            <label className="block text-xs font-medium text-un1t-light mb-1.5">New Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
              placeholder="Strong password"
            />
            <ul className="mt-2 space-y-1">
              {passwordRequirements.map(r => {
                const ok = r.test(password || '')
                return (
                  <li key={r.id} className={`flex items-center gap-2 text-xs ${ok ? 'text-green-400' : 'text-un1t-mid'}`}>
                    {ok ? <Check size={12} /> : <X size={12} />}
                    <span>{r.label}</span>
                  </li>
                )
              })}
            </ul>
          </div>

          <div>
            <label className="block text-xs font-medium text-un1t-light mb-1.5">Confirm Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2.5 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
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
            className="w-full bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            {loading
              ? (flowType === 'invite' ? 'Setting…' : 'Updating…')
              : (flowType === 'invite' ? 'Set Password & Sign In' : 'Update Password')}
          </button>
        </form>

        <p className="text-center text-xs text-un1t-mid mt-6">UN1T CRM v1.0</p>
      </div>
    </div>
  )
}
