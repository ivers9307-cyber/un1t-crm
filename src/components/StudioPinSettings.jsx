'use client'

// STUDIO-PIN.3 — /account section for managing your studio-device PIN
// + home_screen_path.
//
// Two pieces:
//   1. Studio PIN — set / change / clear a 4-digit PIN. The PIN is
//      what you'll type at the Mac / iPad lock screen. Globally
//      unique across the platform.
//   2. Home screen — the URL the Mac / iPad lands on after PIN
//      unlock. Defaults to /dashboard.

import { useState } from 'react'
import { Lock, MapPin, Check, AlertTriangle } from 'lucide-react'

export default function StudioPinSettings({
  hasPinSet,
  pinSetAt,
  homeScreenPath,
}) {
  return (
    <div className="space-y-6">
      <div className="border-t border-un1t-border pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">
          Studio devices
        </h2>
        <PinPanel hasPinSet={hasPinSet} pinSetAt={pinSetAt} />
        <HomeScreenPanel initial={homeScreenPath || '/dashboard'} />
      </div>
    </div>
  )
}

function PinPanel({ hasPinSet, pinSetAt }) {
  const [showForm, setShowForm] = useState(false)
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [isSet, setIsSet] = useState(Boolean(hasPinSet))
  const [setAt, setSetAt] = useState(pinSetAt)

  const save = async (e) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!/^\d{4}$/.test(pin)) {
      setError('PIN must be exactly 4 digits.')
      return
    }
    if (pin !== confirmPin) {
      setError('PINs don\'t match.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/set-pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || 'Failed to save PIN.')
        return
      }
      setIsSet(true)
      setSetAt(new Date().toISOString())
      setShowForm(false)
      setPin('')
      setConfirmPin('')
      setSuccess('PIN saved.')
    } finally {
      setSubmitting(false)
    }
  }

  const clear = async () => {
    if (!confirm('Clear your studio PIN? You won\'t be able to sign in on studio devices until you set a new one.')) return
    setError(null)
    setSuccess(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/set-pin', { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || 'Failed to clear PIN.')
        return
      }
      setIsSet(false)
      setSetAt(null)
      setSuccess('PIN cleared.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl bg-un1t-surface border border-un1t-border p-4 mb-4">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-md bg-un1t-border/40 flex items-center justify-center shrink-0">
          <Lock size={16} className="text-un1t-subtle" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-un1t-text">Studio PIN</div>
          <div className="text-xs text-un1t-subtle mt-0.5">
            {isSet
              ? <>Set {setAt ? `on ${new Date(setAt).toLocaleDateString('en-IE')}` : ''}. Use this 4-digit PIN to sign in on a paired studio Mac or iPad.</>
              : <>You don’t have a PIN yet. Set one to sign in on paired studio Macs and iPads.</>}
          </div>
        </div>
      </div>

      {success && (
        <div className="text-xs text-emerald-300 mb-2 flex items-center gap-1">
          <Check size={12} /> {success}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400 mb-2 flex items-start gap-1">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {showForm ? (
        <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-un1t-subtle">New PIN (4 digits)</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="\d{4}"
              maxLength={4}
              required
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text font-mono text-center tracking-widest"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-un1t-subtle">Confirm</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="\d{4}"
              maxLength={4}
              required
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
              className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text font-mono text-center tracking-widest"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save PIN'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setPin(''); setConfirmPin(''); setError(null) }}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => setShowForm(true)}
            className="text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg hover:bg-un1t-subtle/90"
          >
            {isSet ? 'Change PIN' : 'Set PIN'}
          </button>
          {isSet && (
            <button
              onClick={clear}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
            >
              Clear PIN
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function HomeScreenPanel({ initial }) {
  const [value, setValue] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const presets = [
    { path: '/dashboard',  label: 'Dashboard' },
    { path: '/schedule',   label: 'Schedule' },
    { path: '/contacts',   label: 'Contacts' },
    { path: '/approvals',  label: 'Approvals' },
  ]

  const save = async () => {
    setError(null)
    setSuccess(null)
    if (!/^\/[A-Za-z0-9/_\-]*$/.test(value)) {
      setError('Must be a relative path starting with /.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/set-pin', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ home_screen_path: value }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setError(json.error || 'Failed to save.')
        return
      }
      setSaved(value)
      setSuccess('Home screen saved.')
    } finally {
      setSubmitting(false)
    }
  }

  const dirty = value !== saved

  return (
    <div className="rounded-xl bg-un1t-surface border border-un1t-border p-4">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-md bg-un1t-border/40 flex items-center justify-center shrink-0">
          <MapPin size={16} className="text-un1t-subtle" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-un1t-text">Home screen on studio devices</div>
          <div className="text-xs text-un1t-subtle mt-0.5">
            After PIN unlock, the Mac or iPad lands here. Defaults to your dashboard; reception staff often pick the Schedule.
          </div>
        </div>
      </div>

      {success && (
        <div className="text-xs text-emerald-300 mb-2 flex items-center gap-1">
          <Check size={12} /> {success}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400 mb-2 flex items-start gap-1">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        {presets.map((p) => (
          <button
            key={p.path}
            onClick={() => setValue(p.path)}
            className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
              value === p.path
                ? 'bg-un1t-text text-un1t-bg border-un1t-text'
                : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="/dashboard"
          className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-un1t-text text-sm font-mono"
        />
        <button
          onClick={save}
          disabled={submitting || !dirty}
          className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
        >
          {submitting ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}
