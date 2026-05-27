'use client'

// STUDIO-PIN.3 — idle-lock overlay for studio devices.
//
// Mounts inside the app shell. While the user is active, fires a
// debounced heartbeat to /api/auth/studio-heartbeat once a minute to
// keep the studio_session cookie's last_act fresh. If 5 minutes of
// inactivity pass — or any API call returns 401 because the cookie
// went idle-locked server-side — the overlay covers the UI and the
// staffer must re-enter their PIN.
//
// The overlay POSTs to /api/auth/pin-login with the same
// device_token in localStorage, so PIN re-entry refreshes the
// session in-place without redirecting away from whatever the user
// was looking at.
//
// Renders nothing when the app isn't running on a paired studio
// device (i.e. localStorage has no studio_device_token). The web
// CRM in a regular browser sees no overlay.

import { useState, useEffect, useRef, useCallback } from 'react'
import { Lock, Delete } from 'lucide-react'

const IDLE_MS = 5 * 60 * 1000        // 5 minutes
const HEARTBEAT_MS = 60 * 1000        // every minute when active
const TOKEN_KEY = 'studio_device_token'

const ACTIVITY_EVENTS = [
  'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel',
]

export default function StudioLockOverlay() {
  const [enabled, setEnabled] = useState(false)
  const [locked, setLocked] = useState(false)
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const lastActivityRef = useRef(Date.now())
  const heartbeatTimerRef = useRef(null)
  const lockTimerRef = useRef(null)
  const tokenRef = useRef(null)

  // Detect paired-device-ness once on mount.
  useEffect(() => {
    try {
      const t = window.localStorage.getItem(TOKEN_KEY)
      if (t) {
        tokenRef.current = t
        setEnabled(true)
      }
    } catch {/* no localStorage; never lock */}
  }, [])

  // Heartbeat + idle-detection loop. Only runs when enabled + unlocked.
  useEffect(() => {
    if (!enabled || locked) return undefined

    const onActivity = () => { lastActivityRef.current = Date.now() }
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))

    // Lock checker — fires every 15s, flips to locked if last
    // activity is > IDLE_MS ago.
    lockTimerRef.current = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_MS) {
        setLocked(true)
      }
    }, 15_000)

    // Heartbeat — fires every minute. Skips when user has been idle
    // for the full window (no point refreshing a session that's
    // about to expire anyway).
    heartbeatTimerRef.current = setInterval(async () => {
      const sinceActivity = Date.now() - lastActivityRef.current
      if (sinceActivity > IDLE_MS) return
      try {
        const res = await fetch('/api/auth/studio-heartbeat', { method: 'POST' })
        if (res.status === 401) {
          // Server thinks we're locked. Sync to that state.
          setLocked(true)
        }
      } catch {/* network blip; try again next tick */}
    }, HEARTBEAT_MS)

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity))
      clearInterval(lockTimerRef.current)
      clearInterval(heartbeatTimerRef.current)
    }
  }, [enabled, locked])

  // PIN unlock — POSTs pin-login with the stored device token.
  const submitPin = useCallback(async (pinValue) => {
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/pin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: tokenRef.current, pin: pinValue }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || 'PIN not accepted')
        setPin('')
        return
      }
      // Re-PIN succeeded — clear the lock. Note: if the PIN belongs
      // to a different staffer, getCurrentUser will resolve to that
      // staffer on the next request (session-rotation behaviour from
      // the design doc).
      setLocked(false)
      setPin('')
      lastActivityRef.current = Date.now()
    } catch (e) {
      setError(e.message || 'Network error')
      setPin('')
    } finally {
      setSubmitting(false)
    }
  }, [submitting])

  useEffect(() => {
    if (pin.length === 4 && locked) {
      submitPin(pin)
    }
  }, [pin, locked, submitPin])

  const appendDigit = (d) => {
    if (submitting || pin.length >= 4) return
    setError(null)
    setPin((p) => p + d)
  }
  const backspace = () => {
    if (submitting) return
    setError(null)
    setPin((p) => p.slice(0, -1))
  }

  if (!enabled || !locked) return null

  return (
    <div className="fixed inset-0 z-[9999] bg-un1t-black/95 backdrop-blur-md flex items-center justify-center p-6">
      <div className="w-full max-w-xs">
        <div className="text-center mb-8">
          <Lock size={28} className="mx-auto text-un1t-light mb-3" />
          <div className="text-xs uppercase tracking-widest text-un1t-light mb-2">Locked</div>
          <div className="text-2xl font-bold text-un1t-white">Enter your PIN</div>
        </div>

        <div className="flex items-center justify-center gap-3">
          {[0,1,2,3].map((i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full border-2 transition-colors ${
                error
                  ? 'bg-red-500/30 border-red-500/70'
                  : pin.length > i
                    ? 'bg-un1t-white border-un1t-white'
                    : 'bg-transparent border-un1t-gray'
              }`}
            />
          ))}
        </div>

        {error && (
          <div className="text-center text-xs text-red-400 mt-3">{error}</div>
        )}

        <div className="mt-6 grid grid-cols-3 gap-3">
          {['1','2','3','4','5','6','7','8','9'].map((d) => (
            <button
              key={d}
              onClick={() => appendDigit(d)}
              disabled={submitting}
              className="aspect-square rounded-2xl bg-un1t-dark border border-un1t-gray text-un1t-white text-2xl font-semibold hover:bg-un1t-gray/40 disabled:opacity-40 active:scale-95 transition-transform"
            >
              {d}
            </button>
          ))}
          <div></div>
          <button
            onClick={() => appendDigit('0')}
            disabled={submitting}
            className="aspect-square rounded-2xl bg-un1t-dark border border-un1t-gray text-un1t-white text-2xl font-semibold hover:bg-un1t-gray/40 disabled:opacity-40 active:scale-95 transition-transform"
          >
            0
          </button>
          <button
            onClick={backspace}
            disabled={submitting || pin.length === 0}
            className="aspect-square rounded-2xl bg-un1t-dark border border-un1t-gray text-un1t-light hover:bg-un1t-gray/40 disabled:opacity-40 flex items-center justify-center"
          >
            <Delete size={22} />
          </button>
        </div>
      </div>
    </div>
  )
}
