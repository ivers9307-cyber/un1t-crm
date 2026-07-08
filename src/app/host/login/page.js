'use client'

// Host-portal login (HOST-PORTAL.1). Lives OUTSIDE the gated (portal) route
// group so it isn't caught by the getCurrentHost redirect. Same Supabase
// signInWithPassword as staff — but a host auth user resolves (via host_users)
// to a host, not a staff profile, so the portal only ever shows their data.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function HostLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const supa = createBrowserClient()
      const { error: err } = await supa.auth.signInWithPassword({ email: email.trim(), password })
      if (err) throw new Error(err.message)
      router.push('/host')
      router.refresh()
    } catch (err) {
      setError(err.message || 'Could not sign in')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-bold tracking-[0.3em] text-2xl">UN1T</div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 mt-2">Host portal</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            required
            className="w-full bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/30"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            required
            className="w-full bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/30"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-white text-black font-semibold rounded-lg px-3 py-2.5 text-sm disabled:opacity-60"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-center text-xs text-white/40 mt-6">
          Access is set up by UN1T. Contact us if you need a login.
        </p>
      </div>
    </div>
  )
}
