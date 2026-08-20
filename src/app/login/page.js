// CRM login. Passwordless-first (MAGIC-LINK.1): the primary path emails a
// one-time login link (supabase.auth.signInWithOtp -> /auth/confirm verifies
// the token_hash). Password sign-in is retained as a break-glass fallback so a
// mail/Postmark outage can never lock staff out, and password reset stays for
// break-glass users. Auth emails send via Postmark (custom SMTP).
//
// Branding: per-location logo + company name loaded from /api/public/branding.

'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Lock, Mail } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { safeInternalPath } from '@/lib/urlish'

// useSearchParams wants dynamic rendering; the Suspense boundary lets Next.js
// skip prerender at build time (permanent React 19 / Next 16 pattern).
export default function LoginPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-un1t-bg" />}>
      <LoginInner />
    </Suspense>
  )
}

const CONFIRM_ERRORS = {
  link_expired: 'That login link has expired or was already used. Request a fresh one below.',
  link_invalid: 'That login link was not valid. Request a fresh one below.',
}

function LoginInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Sanitise the post-login redirect: /login?redirect=//evil.com (or
  // javascript:/backslash variants) is otherwise handed to router.push().
  const redirect = safeInternalPath(searchParams.get('redirect'))

  const [mode, setMode] = useState('magic') // 'magic' | 'password' | 'forgot'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Seed the error from a failed /auth/confirm bounce (?error=link_expired).
  const [error, setError] = useState(() => CONFIRM_ERRORS[searchParams.get('error')] || null)
  const [success, setSuccess] = useState(null)
  const [busy, setBusy] = useState(false)
  const [branding, setBranding] = useState(null)

  useEffect(() => {
    fetch('/api/public/branding')
      .then((r) => r.json())
      .then((data) => { if (data.success && data.data) setBranding(data.data) })
      .catch(() => {})
  }, [])

  // Fire-and-forget audit logger (the Supabase auth calls bypass our Node
  // server, so the client reports the attempt). Never blocks/breaks sign-in.
  function logAuthEvent(payload) {
    try {
      fetch('/api/auth/log-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    } catch { /* ignore */ }
  }

  async function handleMagicLink(e) {
    e.preventDefault()
    setBusy(true); setError(null); setSuccess(null)
    try {
      const supa = createBrowserClient()
      // emailRedirectTo -> /auth/callback (PKCE code exchange). shouldCreateUser
      // is defence-in-depth (project signups are disabled server-side); a magic
      // link never provisions a new user. Uses the shared Supabase Magic Link
      // template unchanged — same one the Pulse app uses.
      const { error } = await supa.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })
      logAuthEvent({ action: 'auth.magic_link_requested', email })
      if (error && (error.status === 429 || /rate/i.test(error.message || ''))) {
        setError('Too many requests. Please wait a minute and try again.')
      } else if (error && !/signups? not allowed|not found|otp_disabled/i.test(error.message || '')) {
        // A genuine send failure (network / provider) — surface it instead of a
        // false "link sent" that would strand the user. An unknown email falls
        // through to the generic success below (anti-enumeration).
        setError("Couldn't send the link. Try again, or use a password below.")
      } else {
        // Success, or an unknown email: identical message so a login attempt
        // can't confirm whether an email is a staff account.
        setSuccess(`If that's a staff account, a login link is on its way to ${email}. Check your email.`)
      }
    } catch {
      setError("Couldn't send the link. Try again, or use a password below.")
    } finally {
      setBusy(false)
    }
  }

  async function handlePassword(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const supa = createBrowserClient()
      const { error } = await supa.auth.signInWithPassword({ email, password })
      if (error) {
        logAuthEvent({ action: 'auth.sign_in', ok: false, email, reason: error.message })
        throw error
      }
      logAuthEvent({ action: 'auth.sign_in', ok: true, email })
      router.push(redirect)
      router.refresh()
    } catch (err) {
      setError(err.message || 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleForgot(e) {
    e.preventDefault()
    setBusy(true); setError(null); setSuccess(null)
    try {
      if (!email) throw new Error('Please enter your email address')
      const supa = createBrowserClient()
      const { error } = await supa.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      logAuthEvent({ action: 'auth.password_reset_requested', email })
      setSuccess('Check your email for a password reset link.')
    } catch (err) {
      setError(err.message || 'Could not send the link.')
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next) {
    setMode(next)
    setError(null)
    setSuccess(null)
  }

  const inputClass =
    'w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted'
  const primaryBtn =
    'w-full px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50'
  const linkBtn = 'text-xs text-un1t-subtle hover:text-un1t-text underline underline-offset-2'

  const alerts = (
    <>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && (
        <p className="text-xs text-green-700 bg-green-500/10 border border-green-500/30 rounded p-2">{success}</p>
      )}
    </>
  )

  return (
    <div className="min-h-screen flex items-center justify-center bg-un1t-bg p-4">
      <div className="w-full max-w-sm">
        {/* Logo / wordmark */}
        <div className="text-center mb-8">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={branding.company_name || 'Logo'} className="h-12 mx-auto object-contain" />
          ) : (
            <h1 className="text-3xl font-bold tracking-wider text-un1t-text">{branding?.company_name || 'UN1T'}</h1>
          )}
          <p className="text-sm text-un1t-subtle mt-2">Lead Management</p>
        </div>

        {mode === 'magic' && (
          <form onSubmit={handleMagicLink} className="space-y-3">
            <p className="text-xs text-un1t-subtle inline-flex items-center gap-1.5">
              <Mail size={12} /> Enter your email and we'll send you a login link.
            </p>
            <label className="block">
              <span className="block text-xs text-un1t-subtle mb-1">Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} placeholder="you@un1t.ie" autoComplete="email" className={inputClass} />
            </label>
            <button type="submit" disabled={busy || !email} className={primaryBtn}>
              {busy ? 'Sending…' : 'Email me a login link'}
            </button>
            {alerts}
            <div className="pt-1 text-center">
              <button type="button" onClick={() => switchMode('password')} className={linkBtn}>
                Sign in with a password instead
              </button>
            </div>
          </form>
        )}

        {mode === 'password' && (
          <form onSubmit={handlePassword} className="space-y-3">
            <p className="text-xs text-un1t-subtle inline-flex items-center gap-1.5">
              <Lock size={12} /> Sign in with your password.
            </p>
            <label className="block">
              <span className="block text-xs text-un1t-subtle mb-1">Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} placeholder="you@un1t.ie" autoComplete="email" className={inputClass} />
            </label>
            <label className="block">
              <span className="block text-xs text-un1t-subtle mb-1">Password</span>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder="••••••••" autoComplete="current-password" className={inputClass} />
            </label>
            <button type="submit" disabled={busy || !email || !password} className={primaryBtn}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            {alerts}
            <div className="pt-1 flex items-center justify-between">
              <button type="button" onClick={() => switchMode('magic')} className={linkBtn}>Use a login link</button>
              <button type="button" onClick={() => switchMode('forgot')} className={linkBtn}>Reset password</button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgot} className="space-y-3">
            <p className="text-xs text-un1t-subtle">Enter your email and we'll send you a reset link.</p>
            <label className="block">
              <span className="block text-xs text-un1t-subtle mb-1">Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} placeholder="you@un1t.ie" autoComplete="email" className={inputClass} />
            </label>
            <button type="submit" disabled={busy || !email} className={primaryBtn}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            {alerts}
            <div className="pt-1 text-center">
              <button type="button" onClick={() => switchMode('magic')} className={linkBtn}>Back to sign in</button>
            </div>
          </form>
        )}

        {/* CHROME.1 — the PLATFORM footer, not the gym's. The gym's own
            identity is the <h1> above, which already resolves from
            company_settings (operator-editable); this small print names
            the product the operator is signing in to. */}
        <p className="text-center text-xs text-un1t-muted mt-8">Repset</p>
      </div>
    </div>
  )
}
