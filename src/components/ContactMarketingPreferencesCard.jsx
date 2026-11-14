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
import { Modal, Button, Field } from '@/components/ui'
import { STUDIO_CONSENT_REASONS, STUDIO_CONSENT_NOTE_MAX } from '@/lib/studio-consent-reasons'

// STAFFCONSENT.1 — the words staff pick from when switching one studio's
// marketing email. The keys are stored on consent_log.reason.
const REASON_LABELS = {
  in_person: 'They asked in person',
  phone: 'They asked by phone',
  email: 'They asked by email',
  signed_form: 'They signed a form',
  other: 'Other (say why below)',
}

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
  // STAFFCONSENT.1 — per-studio lists and the reason dialog.
  const [studios, setStudios] = useState([])
  const [studiosError, setStudiosError] = useState(false)
  const [pending, setPending] = useState(null) // { location_id, name, next }
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [studioSaving, setStudioSaving] = useState(false)
  const [studioError, setStudioError] = useState(null)
  const [studioNotice, setStudioNotice] = useState(null)

  // The overall email switch fans an opt-out to every studio row (mig 489),
  // so after it changes the studio list is re-read rather than guessed.
  async function reloadStudios() {
    try {
      const r = await fetch(`/api/contacts/${contactId}/marketing-preferences`)
      const j = await r.json()
      if (j.success) {
        setStudios(Array.isArray(j.studios) ? j.studios : [])
        setStudiosError(Boolean(j.studios_error))
      }
    } catch {
      setStudiosError(true)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(`/api/contacts/${contactId}/marketing-preferences`)
        const j = await r.json()
        if (cancelled) return
        if (j.success) {
          setPrefs(j.preferences)
          setStudios(Array.isArray(j.studios) ? j.studios : [])
          setStudiosError(Boolean(j.studios_error))
        } else setError(j.error || 'Failed to load preferences')
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
        if (key === 'email_marketing') reloadStudios()
        setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500)
      }
    } catch (e) {
      setPrefs((p) => ({ ...p, [key]: before }))
      setError(e?.message || 'Network error')
    } finally {
      setSavingKey(null)
    }
  }

  function openStudioSwitch(studio) {
    if (!studio.can_edit) return
    setPending({ location_id: studio.location_id, name: studio.name, next: !studio.email_marketing })
    setReason('')
    setNote('')
    setStudioError(null)
    setStudioNotice(null)
  }

  const noteTrimmed = note.trim()
  const canSaveStudio = Boolean(pending && reason && (reason !== 'other' || noteTrimmed.length > 0) && !studioSaving)

  async function saveStudioSwitch() {
    if (!canSaveStudio) return
    setStudioSaving(true)
    setStudioError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/studio-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: pending.location_id,
          email_marketing: pending.next,
          reason,
          ...(noteTrimmed ? { note: noteTrimmed } : {}),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.success) {
        setStudioError(j.error || `Could not save (HTTP ${r.status})`)
        return
      }
      // Either way the studio now holds pending.next: a change, or it already did.
      setStudios((list) => list.map((s) => (s.location_id === pending.location_id ? { ...s, email_marketing: pending.next } : s)))
      const changed = Array.isArray(j.data?.changed) ? j.data.changed : []
      setStudioNotice(changed.length === 0
        ? `${pending.name} was already ${pending.next ? 'on' : 'off'}. Nothing changed and no reason was recorded.`
        : null)
      setPending(null)
    } catch (e) {
      setStudioError(e?.message || 'Network error')
    } finally {
      setStudioSaving(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          Marketing preferences
        </h3>
        {!canEdit && (
          <span className="text-[10px] text-un1t-muted inline-flex items-center gap-1">
            <Lock size={10} /> read-only
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-un1t-muted py-2">
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
                    <Icon size={14} className={`mt-0.5 shrink-0 ${on ? 'text-emerald-500' : 'text-un1t-muted'}`} />
                    <div className="min-w-0">
                      <div className="text-sm text-un1t-text">{label}</div>
                      <div className="text-[11px] text-un1t-muted truncate">{description}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    disabled={!canEdit || saving}
                    aria-pressed={on}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                      on ? 'bg-emerald-500' : 'bg-un1t-border'
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
                          ? <Loader2 size={12} className="animate-spin text-un1t-muted" />
                          : <CheckCircle2 size={12} className="text-emerald-500" />}
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>

          {/* STAFFCONSENT.1 — each studio's own marketing email list. A
              person can be on one studio's list and off another's; the
              overall switch above does not change these. */}
          {(studios.length > 0 || studiosError) && (
            <div className="mt-4 pt-3 border-t border-un1t-border/60">
              <div className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
                Studio lists (marketing email)
              </div>
              {studioNotice && (
                <div className="text-[11px] text-amber-700 bg-amber-500/10 rounded p-2 mb-2">{studioNotice}</div>
              )}
              {studiosError && (
                <div className="text-[11px] text-red-700 bg-red-500/10 rounded p-2 mb-2">
                  Could not load the studio lists. Reload to try again.
                </div>
              )}
              <div className="space-y-2">
                {studios.map((studio) => {
                  const on = !!studio.email_marketing
                  return (
                    <div key={studio.location_id} className="flex items-center justify-between gap-2 py-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <Mail size={14} className={`shrink-0 ${on ? 'text-emerald-500' : 'text-un1t-muted'}`} />
                        <span className="text-sm text-un1t-text truncate">{studio.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${on ? 'bg-emerald-500/10 text-emerald-700' : 'bg-gray-500/10 text-gray-700'}`}>
                          {on ? 'On' : 'Off'}
                        </span>
                      </div>
                      {studio.can_edit ? (
                        <button
                          type="button"
                          onClick={() => openStudioSwitch(studio)}
                          aria-pressed={on}
                          aria-label={`${on ? 'Switch off' : 'Switch on'} marketing email at ${studio.name}`}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                            on ? 'bg-emerald-500' : 'bg-un1t-border'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                              on ? 'translate-x-4' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      ) : (
                        <span className="text-[10px] text-un1t-muted inline-flex items-center gap-1">
                          <Lock size={10} /> read-only
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Transactional / utility — explicitly always-on per the
              CLAUDE.md "opting out of marketing should never block a
              booking reminder" convention. Shown for reassurance so
              the operator can see what WILL still go through. */}
          <div className="mt-4 pt-3 border-t border-un1t-border/60">
            <div className="flex items-start gap-2 text-[11px] text-un1t-muted">
              <Lock size={11} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium text-un1t-subtle">Transactional sends remain on</div>
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

      <Modal
        open={Boolean(pending)}
        onClose={() => { if (!studioSaving) setPending(null) }}
        title={pending ? `${pending.next ? 'Switch on' : 'Switch off'} marketing email at ${pending.name}` : ''}
        size="sm"
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setPending(null)} disabled={studioSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={saveStudioSwitch} disabled={!canSaveStudio} loading={studioSaving}>
              Save
            </Button>
          </>
        )}
      >
        {pending && (
          <div className="space-y-3">
            <p className="text-sm text-un1t-subtle">
              {pending.next
                ? `This person will get ${pending.name}'s marketing emails again. Only do this if they asked.`
                : `This person will stop getting ${pending.name}'s marketing emails. Other studios are not changed.`}
            </p>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium text-un1t-text mb-1">Why?</legend>
              {STUDIO_CONSENT_REASONS.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm text-un1t-text">
                  <input
                    type="radio"
                    name="studio-consent-reason"
                    value={key}
                    checked={reason === key}
                    onChange={() => setReason(key)}
                  />
                  {REASON_LABELS[key]}
                </label>
              ))}
            </fieldset>
            <Field
              id="studio-consent-note"
              label={reason === 'other' ? 'Note (required)' : 'Note (optional)'}
              hint={`At most ${STUDIO_CONSENT_NOTE_MAX} characters.`}
            >
              {(controlProps) => (
              <textarea
                {...controlProps}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={STUDIO_CONSENT_NOTE_MAX}
                rows={3}
                className="w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text"
              />
              )}
            </Field>
            {studioError && (
              <div className="flex items-start gap-2 text-xs text-red-700 bg-red-500/10 rounded p-2">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>{studioError}</span>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
