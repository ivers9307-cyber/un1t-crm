'use client'

// STUDIO-PIN.3 — /studio-login client component.
//
// Renders the full-screen PIN entry surface that paired studio
// devices land on. A device-pairing token (one-time string set by a
// master at /admin/studio-devices) is pasted in once, persisted to
// localStorage, then auto-used on every subsequent visit so the
// staffer only sees the PIN pad.
//
// The cleartext token is stored ONLY in localStorage on the device.
// Server-side never sees it again after the initial /api/auth/pin-
// login round-trip. localStorage on a Mac shell / paired iPad is the
// app's own storage scope — it doesn't leak across browser profiles
// or cross-origin.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Lock, Delete, ArrowRight } from 'lucide-react'

const TOKEN_KEY = 'studio_device_token'
const LABEL_KEY = 'studio_device_label'

export default function StudioLogin() {
  const router = useRouter()
  const [token, setToken] = useState(null)
  const [label, setLabel] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [showPairing, setShowPairing] = useState(false)
  const [pairingInput, setPairingInput] = useState('')
  const [pairingLabel, setPairingLabel] = useState('')

  useEffect(() => {
    try {
      const t = window.localStorage.getItem(TOKEN_KEY)
      const l = window.localStorage.getItem(LABEL_KEY)
      if (t) {
        setToken(t)
        setLabel(l || '')
      } else {
        setShowPairing(true)
      }
    } catch {
      // localStorage blocked — force pairing UI.
      setShowPairing(true)
    }
  }, [])

  const submitPin = useCallback(async (pinValue) => {
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/pin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: token, pin: pinValue }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || 'PIN not accepted')
        setPin('')
        return
      }
      const dest = json.profile?.home_screen_path || '/dashboard'
      router.replace(dest)
    } catch (e) {
      setError(e.message || 'Network error')
      setPin('')
    } finally {
      setSubmitting(false)
    }
  }, [token, submitting, router])

  // Auto-submit when the PIN reaches 4 digits.
  useEffect(() => {
    if (pin.length === 4 && token) {
      submitPin(pin)
    }
  }, [pin, token, submitPin])

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

  const savePairing = (e) => {
    e.preventDefault()
    const t = pairingInput.trim()
    if (t.length < 16) {
      setError('That token doesn\'t look right — paste the full pairing token from /admin/studio-devices.')
      return
    }
    try {
      window.localStorage.setItem(TOKEN_KEY, t)
      window.localStorage.setItem(LABEL_KEY, pairingLabel.trim())
      setToken(t)
      setLabel(pairingLabel.trim())
      setShowPairing(false)
      setPairingInput('')
      setPairingLabel('')
      setError(null)
    } catch {
      setError('Could not save pairing — localStorage blocked.')
    }
  }

  const unpair = () => {
    if (!confirm('Forget this device pairing? You\'ll need a fresh token to PIN-login again.')) return
    try {
      window.localStorage.removeItem(TOKEN_KEY)
      window.localStorage.removeItem(LABEL_KEY)
    } catch {/* swallow */}
    setToken(null)
    setLabel('')
    setShowPairing(true)
  }

  if (showPairing) {
    return (
      <div className="min-h-screen bg-un1t-black flex items-center justify-center p-6">
        <form onSubmit={savePairing} className="w-full max-w-md bg-un1t-dark border border-un1t-gray rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Lock size={18} className="text-un1t-light" />
            <h1 className="text-lg font-semibold text-un1t-white">Pair this device</h1>
          </div>
          <p className="text-sm text-un1t-light">
            Ask a master to create a pairing token at <span className="font-mono">/admin/studio-devices</span> and paste it here.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-un1t-light">Pairing token</span>
            <input
              autoFocus
              value={pairingInput}
              onChange={(e) => setPairingInput(e.target.value)}
              className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-un1t-white font-mono text-sm"
              placeholder="Paste the token here"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-un1t-light">Device label (optional, for your records)</span>
            <input
              value={pairingLabel}
              onChange={(e) => setPairingLabel(e.target.value)}
              className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-un1t-white text-sm"
              placeholder="Reception Mac"
            />
          </label>
          {error && (
            <div className="text-xs text-red-400">{error}</div>
          )}
          <button
            type="submit"
            className="w-full bg-un1t-white text-un1t-black font-medium px-3 py-2.5 rounded-md flex items-center justify-center gap-2 hover:bg-un1t-light/90"
          >
            Pair device <ArrowRight size={14} />
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-un1t-black flex items-center justify-center p-6">
      <div className="w-full max-w-xs">
        <div className="text-center mb-8">
          <div className="text-xs uppercase tracking-widest text-un1t-light mb-2">CF Studio</div>
          <div className="text-2xl font-bold text-un1t-white">Enter your PIN</div>
          {label && <div className="text-xs text-un1t-mid mt-1">{label}</div>}
        </div>

        <PinDisplay value={pin} error={Boolean(error)} />

        {error && (
          <div className="text-center text-xs text-red-400 mt-3 mb-1">{error}</div>
        )}

        <div className="mt-6 grid grid-cols-3 gap-3">
          {['1','2','3','4','5','6','7','8','9'].map((d) => (
            <PinButton key={d} digit={d} onPress={() => appendDigit(d)} disabled={submitting} />
          ))}
          <div></div>
          <PinButton digit="0" onPress={() => appendDigit('0')} disabled={submitting} />
          <button
            onClick={backspace}
            disabled={submitting || pin.length === 0}
            className="aspect-square rounded-2xl bg-un1t-dark border border-un1t-gray text-un1t-light hover:bg-un1t-gray/40 disabled:opacity-40 flex items-center justify-center"
          >
            <Delete size={22} />
          </button>
        </div>

        <button
          onClick={unpair}
          className="block mx-auto mt-8 text-[11px] text-un1t-mid hover:text-un1t-light underline"
        >
          Forget pairing on this device
        </button>
      </div>
    </div>
  )
}

function PinDisplay({ value, error }) {
  return (
    <div className="flex items-center justify-center gap-3">
      {[0,1,2,3].map((i) => (
        <div
          key={i}
          className={`w-4 h-4 rounded-full border-2 transition-colors ${
            error
              ? 'bg-red-500/30 border-red-500/70'
              : value.length > i
                ? 'bg-un1t-white border-un1t-white'
                : 'bg-transparent border-un1t-gray'
          }`}
        />
      ))}
    </div>
  )
}

function PinButton({ digit, onPress, disabled }) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className="aspect-square rounded-2xl bg-un1t-dark border border-un1t-gray text-un1t-white text-2xl font-semibold hover:bg-un1t-gray/40 disabled:opacity-40 active:scale-95 transition-transform"
    >
      {digit}
    </button>
  )
}
