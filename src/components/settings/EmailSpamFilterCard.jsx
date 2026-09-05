'use client'

// MAIL-SPAM.1 — per-location inbound spam filter card.
//
// Settings -> Locations -> <name> -> Details, beside send quiet hours and the
// email copy. One switch and one number, backed by
// company_settings.email_spam_filter_enabled / email_spam_threshold (mig 584).
//
// WHAT THE NUMBER DOES: Postmark scores every inbound email with SpamAssassin
// (SpamScore). At or above this threshold the conversation is created but
// QUARANTINED — it shows only on Mail's Spam view, pings nobody, and does not
// count towards the badge — until an operator clicks Not spam or the 30-day
// purge removes it. Below it, mail files normally. No score at all is never
// spam (a lost lead is worse than a spam ticket), and switching the filter off
// quarantines nothing while still recording the score.
//
// Operator-editable rather than a constant because 5.0 is a sensible default
// for one studio's mail and wrong for another's: a studio drowning in junk
// tightens it, one that has lost a real enquiry loosens it.
//
// Reads + writes via /api/locations/[id]/email-spam-filter.

import { useEffect, useState } from 'react'
import { ShieldAlert, Loader2, Check, AlertTriangle } from 'lucide-react'
import {
  DEFAULT_EMAIL_SPAM_SETTINGS,
  SPAM_THRESHOLD_MIN,
  SPAM_THRESHOLD_MAX,
  SPAM_RETENTION_DAYS,
} from '@/lib/email-spam'

export default function EmailSpamFilterCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [enabled, setEnabled] = useState(DEFAULT_EMAIL_SPAM_SETTINGS.enabled)
  // Kept as the operator's TEXT while editing so "5." and "" are typeable;
  // parsed at save and for validity.
  const [thresholdText, setThresholdText] = useState(String(DEFAULT_EMAIL_SPAM_SETTINGS.threshold))
  const [defaultThreshold, setDefaultThreshold] = useState(DEFAULT_EMAIL_SPAM_SETTINGS.threshold)
  const [saved, setSaved] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/locations/${locationId}/email-spam-filter`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success) {
          setError(j.error || `HTTP ${res.status}`)
        } else {
          setEnabled(j.data.enabled)
          setThresholdText(String(j.data.threshold))
          setDefaultThreshold(j.data.default_threshold)
          setSaved({ enabled: j.data.enabled, threshold: j.data.threshold })
          setCanEdit(!!j.data.can_edit)
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  const threshold = thresholdText.trim() === '' ? NaN : Number(thresholdText)
  const thresholdValid = Number.isFinite(threshold)
    && threshold >= SPAM_THRESHOLD_MIN && threshold <= SPAM_THRESHOLD_MAX
  const dirty = !saved || enabled !== saved.enabled || threshold !== saved.threshold

  async function save() {
    if (!thresholdValid || saving) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email-spam-filter`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, threshold }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
      } else {
        setEnabled(j.data.enabled)
        setThresholdText(String(j.data.threshold))
        setSaved({ enabled: j.data.enabled, threshold: j.data.threshold })
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
      }
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading spam filter…
      </div>
    )
  }

  return (
    <section className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2">
            <ShieldAlert size={14} className="text-un1t-subtle" />
            <h4 className="text-sm font-semibold text-un1t-text">Inbound spam filter</h4>
          </div>
          <p className="text-xs text-un1t-subtle mt-1 max-w-md">
            Every email that arrives carries a spam score from the mail provider.
            At or above this number the conversation is kept but quarantined: it
            appears only on Mail&apos;s Spam view, nobody is notified, and it does
            not count towards the badge. Not spam releases it to the inbox.
            Anything still quarantined after {SPAM_RETENTION_DAYS} days is deleted.
            Mail with no score is never treated as spam.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable inbound spam filter"
            onClick={() => setEnabled(v => !v)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
              enabled ? 'bg-un1t-text' : 'bg-un1t-border'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-un1t-bg transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-un1t-text">
        <label htmlFor="spam-threshold" className={enabled ? '' : 'text-un1t-subtle'}>
          Quarantine at a score of
        </label>
        <input
          id="spam-threshold"
          type="number"
          inputMode="decimal"
          step="0.5"
          min={SPAM_THRESHOLD_MIN}
          max={SPAM_THRESHOLD_MAX}
          value={thresholdText}
          disabled={!canEdit}
          onChange={(e) => setThresholdText(e.target.value)}
          className="w-20 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        />
        <span className={enabled ? '' : 'text-un1t-subtle'}>or more</span>
        <span className="text-un1t-muted">
          (default {defaultThreshold}; lower catches more, higher lets more through)
        </span>
      </div>
      {!thresholdValid && (
        <p className="mt-1 text-xs text-red-700">
          Enter a number from {SPAM_THRESHOLD_MIN} to {SPAM_THRESHOLD_MAX}.
        </p>
      )}
      {!enabled && (
        <p className="mt-1 text-xs text-un1t-muted">
          Off: every email files normally. Scores are still recorded on each conversation.
        </p>
      )}

      {error && (
        <div className="mt-2 text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || !thresholdValid || saving}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
          </button>
          {savedFlash && (
            <span className="inline-flex items-center gap-1 text-xs text-green-700">
              <Check size={12} /> Saved
            </span>
          )}
        </div>
      )}
    </section>
  )
}
