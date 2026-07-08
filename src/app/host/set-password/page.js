'use client'

// Host-portal set-password / accept-invite (HOST-PORTAL.1). The invite email's
// link lands here; the token-handling below is copied VERBATIM from the staff
// /reset-password page (hardened against CVE-internal 2026-05-13 + the
// 2026-06 session-race) — do not simplify. Only the styling (dark host brand)
// and the success redirect (/host) differ. Lives OUTSIDE the (portal) gate.

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { passwordRequirements, validatePasswordComplexity } from '@/lib/schemas'

export default function HostSetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [flowType, setFlowType] = useState('recovery')
  const supabaseRef = useRef(null)
  const router = useRouter()

  useEffect(() => {
    // Sign out any existing session FIRST, then establish ONLY the recovery/
    // invite session from the link's token, so updateUser() can only ever hit
    // the invited user. detectSessionInUrl:false so we control the sequence.
    if (typeof window === 'undefined') return

    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''))
    const searchParams = new URLSearchParams(window.location.search || '')
    const t = hashParams.get('type') || searchParams.get('type')
    if (t === 'invite') setFlowType('invite')
    else if (t === 'recovery') setFlowType('recovery')

    const code = searchParams.get('code')
    const tokenHash = searchParams.get('token_hash') || hashParams.get('token_hash')
    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')

    const supabase = createBrowserClient({ auth: { detectSessionInUrl: false } })
    supabaseRef.current = supabase
    let cancelled = false

    ;(async () => {
      try {
        try { await supabase.auth.signOut({ scope: 'local' }) } catch { /* ignore */ }
        if (cancelled) return

        if (code) {
          const { error: exErr } = await supabase.auth.exchangeCodeForSession(code)
          if (exErr) throw exErr
        } else if (accessToken && refreshToken) {
          const { error: ssErr } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          if (ssErr) throw ssErr
        } else if (tokenHash) {
          const { error: otpErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: t === 'invite' ? 'invite' : 'recovery' })
          if (otpErr) throw otpErr
        } else {
          throw new Error('this link is missing its verification token')
        }
        if (cancelled) return

        const { data: sessData } = await supabase.auth.getSession()
        if (cancelled) return
        if (sessData?.session) setReady(true)
        else throw new Error('no session was established')
      } catch (e) {
        if (!cancelled) {
          setError(`Link could not be verified: ${e?.message || 'unknown error'}. Ask UN1T for a fresh invite.`)
        }
      }
    })()

    return () => { cancelled = true }
  }, [])

  async function handleSet(e) {
    e.preventDefault()
    setError(null)
    const pwError = validatePasswordComplexity(password)
    if (pwError) { setError(pwError); return }
    if (password !== confirmPassword) { setError('Passwords do not match'); return }

    setLoading(true)
    const supabase = supabaseRef.current
    if (!ready || !supabase) {
      setError('Link not verified yet. Wait a moment and try again, or ask for a fresh invite.')
      setLoading(false)
      return
    }
    const { error: upErr } = await supabase.auth.updateUser({ password })
    if (upErr) {
      setError(upErr.message)
      setLoading(false)
    } else {
      router.push('/host')
      router.refresh()
    }
  }

  const input = 'w-full bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/30'

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-bold tracking-[0.3em] text-2xl">UN1T</div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 mt-2">Host portal</p>
        </div>
        <form onSubmit={handleSet} className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold">{flowType === 'invite' ? 'Welcome — set your password' : 'Set a new password'}</h2>
            <p className="text-xs text-white/50 mt-1">You&apos;ll use this with your email to sign in from now on.</p>
          </div>

          {!ready && !error && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
              Verifying your invite…
            </div>
          )}

          <div>
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" autoComplete="new-password" className={input} />
            <ul className="mt-2 space-y-1">
              {passwordRequirements.map((r) => {
                const ok = r.test(password || '')
                return (
                  <li key={r.id} className={`flex items-center gap-2 text-xs ${ok ? 'text-emerald-400' : 'text-white/40'}`}>
                    {ok ? <Check size={12} /> : <X size={12} />}<span>{r.label}</span>
                  </li>
                )
              })}
            </ul>
          </div>

          <input type="password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password" autoComplete="new-password" className={input} />

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button type="submit" disabled={loading || !ready} className="w-full bg-white text-black font-semibold rounded-lg px-3 py-2.5 text-sm disabled:opacity-60">
            {loading ? 'Setting…' : 'Set password & sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
