'use client'

// Host-portal set-password / accept-invite (HOST-PORTAL.1). The invite email's
// link lands here; the token handshake is SHARED with the staff /reset-password
// page via `@/lib/recovery-link` (hardened against CVE-internal 2026-05-13, the
// 2026-06 session-race and the 2026-07-31 PKCE-verifier bug). It used to be a
// verbatim copy, which meant it carried the same bug — keep it shared. Only the
// styling (the host theme, light or dark) and the success redirect (/host) differ. Lives
// OUTSIDE the (portal) gate.
//
// W1.S1c: page.js (server) resolves the request host's organisation brand and
// passes it in; this client body only renders it.

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { passwordRequirements, validatePasswordComplexity } from '@/lib/schemas'
import { HOST_BTN_PRIMARY, HOST_EYEBROW, HOST_HINT, HOST_INPUT, HOST_LABEL, HOST_NOTICE, HOST_NOTICE_TONE, HOST_SECTION } from '@/components/host/host-ui'
import { parseRecoveryLink, establishRecoverySession } from '@/lib/recovery-link'

export default function HostSetPasswordForm({ brand }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [flowType, setFlowType] = useState('recovery')
  const supabaseRef = useRef(null)
  // The user id the link verified as — handleSet pins the write to it.
  const linkUserRef = useRef(null)
  const router = useRouter()

  useEffect(() => {
    // Establish ONLY the invite/recovery session from the link's token, so
    // updateUser() can only ever hit the invited user. Sign-out happens on
    // the failure paths inside establishRecoverySession — doing it up front
    // deleted the PKCE code verifier the exchange needs (RESET-PKCE.1).
    // detectSessionInUrl:false so we control the sequence.
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
        if (!cancelled) setError(e?.message || 'Link could not be verified.')
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
    // Re-check at the moment of the write that the live session is still the
    // account the link verified as (CVE-internal 2026-05-13).
    const { data: live } = await supabase.auth.getUser()
    if (!live?.user || live.user.id !== linkUserRef.current) {
      setError('This session no longer matches the invite link. Ask for a fresh invite.')
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

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-bold tracking-[0.3em] text-2xl">{brand.shortName}</div>
          <p className={`${HOST_EYEBROW} mt-2`}>Host portal</p>
        </div>
        <form onSubmit={handleSet} className="space-y-4">
          <div>
            <h2 className={HOST_SECTION}>{flowType === 'invite' ? 'Welcome — set your password' : 'Set a new password'}</h2>
            <p className={`${HOST_HINT} mt-1`}>You&apos;ll use this with your email to sign in from now on.</p>
          </div>

          {!ready && !error && (
            <div className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.warn}`}>
              Verifying your invite…
            </div>
          )}

          <div>
            <label htmlFor="host-new-password" className={`${HOST_LABEL} mb-1.5`}>New password</label>
            <input id="host-new-password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" autoComplete="new-password" className={HOST_INPUT} />
            <ul className="mt-2 space-y-1">
              {passwordRequirements.map((r) => {
                const ok = r.test(password || '')
                return (
                  <li key={r.id} className={`flex items-center gap-2 text-xs ${ok ? 'text-host-ok' : 'text-host-hint'}`}>
                    {ok ? <Check size={12} /> : <X size={12} />}<span>{r.label}</span>
                  </li>
                )
              })}
            </ul>
          </div>

          <div>
            <label htmlFor="host-confirm-password" className={`${HOST_LABEL} mb-1.5`}>Confirm password</label>
            <input id="host-confirm-password" type="password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password" autoComplete="new-password" className={HOST_INPUT} />
          </div>

          {error && <p className="text-sm text-host-bad">{error}</p>}

          <button type="submit" disabled={loading || !ready} className={`${HOST_BTN_PRIMARY} w-full`}>
            {loading ? 'Setting…' : 'Set password & sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
