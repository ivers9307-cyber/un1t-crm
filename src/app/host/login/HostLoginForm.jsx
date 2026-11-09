'use client'

// Host-portal login (HOST-PORTAL.1). Lives OUTSIDE the gated (portal) route
// group so it isn't caught by the getCurrentHost redirect. Same Supabase
// signInWithPassword as staff — but a host auth user resolves (via host_users)
// to a host, not a staff profile, so the portal only ever shows their data.
//
// W1.S1c: page.js (server) resolves the request host's organisation brand and
// passes it in; this client body only renders it.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { HOST_BTN_PRIMARY, HOST_EYEBROW, HOST_INPUT, HOST_LABEL, HOST_META } from '@/components/host/host-ui'

export default function HostLoginForm({ brand }) {
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
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-bold tracking-[0.3em] text-2xl">{brand.shortName}</div>
          <p className={`${HOST_EYEBROW} mt-2`}>Host portal</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="host-login-email" className={`${HOST_LABEL} mb-1.5`}>Email</label>
            <input
              id="host-login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              required
              className={HOST_INPUT}
            />
          </div>
          <div>
            <label htmlFor="host-login-password" className={`${HOST_LABEL} mb-1.5`}>Password</label>
            <input
              id="host-login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              required
              className={HOST_INPUT}
            />
          </div>
          {error && <p className="text-sm text-host-bad">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className={`${HOST_BTN_PRIMARY} w-full`}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className={`text-center ${HOST_META} mt-6`}>
          Access is set up by {brand.name}. Contact them if you need a login.
        </p>
      </div>
    </div>
  )
}
