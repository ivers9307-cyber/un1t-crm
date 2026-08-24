'use client'

// Client-side form for /account preferences. Currently a single
// dropdown (landing preference) — additional self-service prefs
// would slot in here as additional sections.
//
// On save: PATCH /api/me/preferences with { landing_preference }.
// The dropdown is disabled while the request is in flight; success
// shows a brief confirmation, error shows the server message.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, AlertCircle, Loader2 } from 'lucide-react'
import { LANDING_PREFERENCE_OPTIONS } from '@shared/permissions'

export default function AccountForm({ initialPreference, allowed }) {
  const router = useRouter()
  const [preference, setPreference] = useState(initialPreference || 'auto')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // 'saved' | 'error'
  const [error, setError] = useState(null)

  // Dirty flag — we only show the Save button when something changed.
  const dirty = preference !== (initialPreference || 'auto')

  async function handleSave() {
    setSaving(true); setStatus(null); setError(null)
    try {
      const res = await fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ landing_preference: preference }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to save')
      setStatus('saved')
      // Refresh server-rendered pages so the new preference takes
      // effect immediately on the next visit to /dashboard.
      router.refresh()
      setTimeout(() => setStatus(null), 2500)
    } catch (e) {
      setStatus('error')
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold text-un1t-text">Default landing page</h2>
        <p className="text-xs text-un1t-subtle mt-1">
          The page you see first when you open the CRM on web. On mobile this picks which dashboard the Dashboard tab opens on.
        </p>
      </div>

      <div className="border-t border-un1t-border">
        {LANDING_PREFERENCE_OPTIONS.map((opt) => {
          const isAllowed = allowed[opt.value]
          const selected = preference === opt.value
          return (
            <label
              key={opt.value}
              className={`flex items-start gap-3 px-5 py-3.5 border-b border-un1t-border last:border-b-0 transition-colors ${
                isAllowed ? 'cursor-pointer hover:bg-un1t-border/30' : 'opacity-50 cursor-not-allowed'
              } ${selected && isAllowed ? 'bg-un1t-border/40' : ''}`}
            >
              <input
                type="radio"
                name="landing_preference"
                value={opt.value}
                checked={selected}
                disabled={!isAllowed || saving}
                onChange={() => isAllowed && setPreference(opt.value)}
                className="mt-1 accent-un1t-text shrink-0"
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-un1t-text flex items-center gap-2">
                  {opt.label}
                  {!isAllowed && opt.value !== 'auto' && (
                    <span className="text-[10px] uppercase tracking-wider text-un1t-muted">
                      not available at this location
                    </span>
                  )}
                </div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  {opt.hint}
                </div>
              </div>
            </label>
          )
        })}
      </div>

      <div className="px-5 py-4 border-t border-un1t-border flex items-center justify-between gap-3">
        <div className="min-h-5 text-xs">
          {status === 'saved' && (
            <span className="flex items-center gap-1.5 text-emerald-500">
              <Check size={14} /> Saved
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center gap-1.5 text-red-500">
              <AlertCircle size={14} /> {error}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            dirty && !saving
              ? 'bg-un1t-text text-un1t-bg hover:bg-un1t-text/90'
              : 'bg-un1t-border text-un1t-subtle cursor-not-allowed'
          }`}
        >
          {saving ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" /> Saving…
            </span>
          ) : 'Save'}
        </button>
      </div>
    </div>
  )
}
