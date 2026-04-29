'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = searchParams.get('redirect') || '/'

  async function handleLogin(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const supabase = createBrowserClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push(redirect)
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-wider text-white">UN1T</h1>
          <p className="text-sm text-gray-500 mt-1">Lead Management</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleLogin} className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-un1t-light mb-1.5">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2.5 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40"
              placeholder="you@un1t.ie"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-un1t-light mb-1.5">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2.5 text-sm text-white placeholder:text-un1t-mid focus:outline-none focus:border-white/40"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-white text-black font-medium text-sm py-2.5 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="text-center text-xs text-un1t-mid mt-6">UN1T CRM v1.0</p>
      </div>
    </div>
  )
}
