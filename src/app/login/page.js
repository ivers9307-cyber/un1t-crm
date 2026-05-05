// CRM login. Visual refresh to match platform.un1tdublin.com:
// no card frame, tab strip between Sign in / Reset password,
// lighter spacing. Auth flow unchanged — same signInWithPassword
// + resetPasswordForEmail behaviour as before.
//
// Branding: per-location logo + company name still loaded from
// /api/public/branding so the buyer sees the right brand on
// their first touch (the same surface the deposit page uses).

'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Lock, Mail } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'

// useSearchParams wants dynamic rendering; Suspense lets Next 14
// skip prerender at build time.
export default function LoginPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-un1t-black" />}>
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get('redirect') || '/'

  const [mode, setMode] = useState('login') // 'login' | 'forgot'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [busy, setBusy] = useState(false)
  const [branding, setBranding] = useState(null)

  // Per-location branding — loaded from /api/public/branding.
  // Falls back to the 'UN1T' wordmark if no logo is configured at
  // the active location.
  useEffect(() => {
    fetch('/api/public/branding')
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.data) setBranding(data.data)
      })
      .catch(() => {})
  }, [])

  async function handleLogin(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const supa = createBrowserClient()
      const { error } = await supa.auth.signInWithPassword({ email, password })
      if (error) throw error
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-un1t-black p-4">
      <div className="w-full max-w-sm">
        {/* Logo / wordmark */}
        <div className="text-center mb-8">
          {branding?.logo_url ? (
            <img
              src={branding.logo_url}
              alt={branding.company_name || 'Logo'}
              className="h-12 mx-auto object-contain"
            />
          ) : (
            <h1 className="text-3xl font-bold tracking-wider text-un1t-white">
              {branding?.company_name || 'UN1T'}
            </h1>
          )}
          <p className="text-sm text-un1t-light mt-2">Lead Management</p>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 mb-4 bg-un1t-dark border border-un1t-gray rounded-md p-1">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`flex-1 py-1.5 text-xs rounded transition-colors inline-flex items-center justify-center gap-1.5 ${
              mode === 'login'
                ? 'bg-un1t-gray/60 text-un1t-white'
                : 'text-un1t-light hover:text-un1t-white'
            }`}
          >
            <Lock size={12} /> Sign in
          </button>
          <button
            type="button"
            onClick={() => switchMode('forgot')}
            className={`flex-1 py-1.5 text-xs rounded transition-colors inline-flex items-center justify-center gap-1.5 ${
              mode === 'forgot'
                ? 'bg-un1t-gray/60 text-un1t-white'
                : 'text-un1t-light hover:text-un1t-white'
            }`}
          >
            <Mail size={12} /> Reset password
          </button>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-3">
            <label className="block">
              <span className="block text-xs text-un1t-light mb-1">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                placeholder="you@un1t.ie"
                autoComplete="email"
                className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-un1t-light mb-1">Password</span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !email || !password}
              className="w-full px-4 py-2 rounded-md bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            {error && <p className="text-xs text-red-400">{error}</p>}
          </form>
        ) : (
          <form onSubmit={handleForgot} className="space-y-3">
            <p className="text-xs text-un1t-light">
              Enter your email and we'll send you a reset link.
            </p>
            <label className="block">
              <span className="block text-xs text-un1t-light mb-1">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                placeholder="you@un1t.ie"
                autoComplete="email"
                className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !email}
              className="w-full px-4 py-2 rounded-md bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            {error && <p className="text-xs text-red-400">{error}</p>}
            {success && (
              <p className="text-xs text-green-400 bg-green-500/10 border border-green-500/30 rounded p-2">
                {success}
              </p>
            )}
          </form>
        )}

        <p className="text-center text-xs text-un1t-mid mt-8">UN1T CRM</p>
      </div>
    </div>
  )
}
