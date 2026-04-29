'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [branding, setBranding] = useState(null)
  const router = useRouter()

  useEffect(() => {
    fetch('/api/public/branding')
      .then(r => r.json())
      .then(data => { if (data.success && data.data) setBranding(data.data) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    // Supabase automatically picks up the recovery token from the URL hash
    // when the user clicks the reset link. We just need to wait for the session.
    const supabase = createBrowserClient()
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setReady(true)
      }
    })
    // Also check if we already have a session (token already processed)
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true)
    })
  }, [])

  async function handleReset(e) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

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
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={branding.company_name || 'Logo'} className="h-10 mx-auto object-contain" />
          ) : (
            <h1 className="text-3xl font-bold tracking-wider text-white">{branding?.company_name || 'UN1T'}</h1>
          )}
          <p className="text-sm text-gray-500 mt-1">Lead Management</p>
        </div>

        <form onSubmit={handleReset} className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-white mb-1">Set a new password</h2>
            <p className="text-xs text-un1t-light">Enter your new password below.</p>
          </div>

          {!ready && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs rounded-md p-3">
              Verifying your reset link... If this persists, request a new link from the login page.
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
              className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2.5 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40"
              placeholder="At least 8 characters"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-un1t-light mb-1.5">Confirm Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2.5 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40"
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
            className="w-full bg-white text-black font-medium text-sm py-2.5 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>

        <p className="text-center text-xs text-un1t-mid mt-6">UN1T CRM v1.0</p>
      </div>
    </div>
  )
}
