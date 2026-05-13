'use client'

// CONSENT.1 — operator-facing marketing-channel toggles for the
// contact profile page.
//
// Lets master / owner-tier roles flip the three MARKETING channels
// (email_marketing, sms_marketing, whatsapp_marketing) for a contact.
// Transactional / administrative sends (booking confirmations,
// reminders, account updates) stay always-on and are not editable
// from this card — operators almost never want to disable those, and
// the customer's own preference centre at /preferences/[token]
// already covers that case.
//
// Lazy-loads on mount so the contact page doesn't pay a round-trip
// for it on initial render. Optimistic UI: the toggle flips
// immediately, then either stays put on success or rolls back if
// the API rejects.

import { useState, useEffect } from 'react'
import { Mail, MessageSquare, MessageCircle, Loader2, Lock, AlertCircle, CheckCircle2 } from 'lucide-react'

const MARKETING_CHANNELS = [
  {
    key: 'email_marketing',
    label: 'Email',
    description: 'Promotions, class updates, newsletters',
    Icon: Mail,
  },
  {
    key: 'sms_marketing',
    label: 'SMS',
    description: 'Promotions and offers via text',
    Icon: MessageSquare,
  },
  {
    key: 'whatsapp_marketing',
    label: 'WhatsApp',
    description: 'Promotions and offers via WhatsApp',
    Icon: MessageCircle,
  },
]

const TRANSACTIONAL_CHANNELS = [
  { key: 'email_administrative',    label: 'Email',    Icon: Mail },
  { key: 'sms_administrative',      label: 'SMS',      Icon: MessageSquare },
  { key: 'whatsapp_administrative', label: 'WhatsApp', Icon: MessageCircle },
]

export default function ContactMarketingPreferencesCard({ contactId, canEdit, glofoxMembershipStatus }) {
  // CONSENT.2 — flag this card when the contact is a ClassPass user.
  // Mig 151's trigger blanket-disables every channel (marketing AND
  // administrative) on transition to classpass_payg, so any ClassPass
  // contact's panel will appear all-off. Show a banner so the
  // operator understands why and knows that re-enabling a channel
  // here will stick (the trigger only fires on STATUS transitions,
  // not on every contact write).
  const isClasspass = glofoxMembershipStatus === 'classpass_payg'
  const [prefs, setPrefs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [savingKey, setSavingKey] = useState(null)
  const [savedKey, setSavedKey] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(`/api/contacts/${contactId}/marketing-preferences`)
        const j = await r.json()
        if (cancelled) return
        if (j.success) setPrefs(j.preferences)
        else setError(j.error || 'Failed to load preferences')
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [contactId])

  async function toggle(key) {
    if (!canEdit || !prefs) return
    const before = prefs[key]
    const next = !before
    // Optimistic flip.
    setPrefs({ ...prefs, [key]: next })
    setSavingKey(key)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/marketing-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      })
      const j = await r.json()
      if (!r.ok || !j.success) {
        // Roll back.
        setPrefs((p) => ({ ...p, [key]: before }))
        setError(j.error || `HTTP ${r.status}`)
      } else {
        setSavedKey(key)
        setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500)
      }
    } catch (e) {
      setPrefs((p) => ({ ...p, [key]: before }))
      setError(e?.message || 'Network error')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">
          Marketing preferences
        </h3>
        {!canEdit && (
          <span className="text-[10px] text-un1t-mid inline-flex items-center gap-1">
            <Lock size={10} /> read-only
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-un1t-mid py-2">
          <Loader2 size={12} className="animate-spin" /> loading…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 mb-3">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && isClasspass && (
        <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded p-2 mb-3">
          <AlertCircle size={12} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium text-amber-800">Auto-unsubscribed (ClassPass policy)</div>
            <div className="mt-0.5">
              Every channel — marketing AND transactional — is disabled by default for
              ClassPass contacts to protect deliverability. You can re-enable individual
              channels below if you genuinely need to message this person; the trigger
              won&apos;t override your choice on subsequent contact updates.
            </div>
          </div>
        </div>
      )}

      {!loading && prefs && (
        <>
          <div className="space-y-2">
            {MARKETING_CHANNELS.map(({ key, label, description, Icon }) => {
              const on = !!prefs[key]
              const saving = savingKey === key
              const saved  = savedKey === key
              return (
                <div key={key} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="flex items-start gap-2 min-w-0">
                    <Icon size={14} className={`mt-0.5 shrink-0 ${on ? 'text-emerald-500' : 'text-un1t-mid'}`} />
                    <div className="min-w-0">
                      <div className="text-sm text-un1t-white">{label}</div>
                      <div className="text-[11px] text-un1t-mid truncate">{description}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    disabled={!canEdit || saving}
                    aria-pressed={on}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      on ? 'bg-emerald-500' : 'bg-un1t-gray'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                        on ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                    {(saving || saved) && (
                      <span className="absolute -right-5 top-0.5">
                        {saving
                          ? <Loader2 size={12} className="animate-spin text-un1t-mid" />
                          : <CheckCircle2 size={12} className="text-emerald-500" />}
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>

          {/* Transactional / utility — explicitly always-on per the
              CLAUDE.md "opting out of marketing should never block a
              booking reminder" convention. Shown for reassurance so
              the operator can see what WILL still go through. */}
          <div className="mt-4 pt-3 border-t border-un1t-gray/60">
            <div className="flex items-start gap-2 text-[11px] text-un1t-mid">
              <Lock size={11} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium text-un1t-light">Transactional sends remain on</div>
                <div className="mt-1">
                  Booking confirmations, class reminders, schedule changes and account
                  updates always go through on{' '}
                  {TRANSACTIONAL_CHANNELS
                    .filter((c) => prefs[c.key] !== false)
                    .map((c) => c.label)
                    .join(' · ') || '—'}
                  . The customer can change this themselves via their preference
                  centre link.
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
