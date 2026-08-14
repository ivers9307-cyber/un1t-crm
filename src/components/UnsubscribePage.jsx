'use client'

// Unified unsubscribe page (Phase 5A). Replaces the original
// email-only stub with a three-channel opt-out flow: email, WhatsApp,
// and SMS marketing. All three are pre-checked since the user clicked
// "Unsubscribe" — they can untick whichever they want to keep.
//
// Caveat callout: utility / administrative communications (booking
// confirmations, reminders, schedule changes, deposit receipts)
// continue to send regardless of marketing opt-out. The user can
// turn those off too via the deeper /preferences/[token] preference
// centre, where each administrative channel is its own toggle.
//
// API contract: POST /api/unsubscribe/[token] with
//   { channels: ['email_marketing', 'whatsapp_marketing', 'sms_marketing'] }
// The route preserves back-compat with the empty-body List-Unsubscribe
// header path (defaults to email_marketing only when no body is sent).

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Mail, MessageCircle, MessageSquare, Check } from 'lucide-react'

const CHANNEL_OPTIONS = [
  {
    key: 'email_marketing',
    label: 'Email marketing',
    description: 'Promotions, newsletters, class updates',
    Icon: Mail,
  },
  {
    key: 'whatsapp_marketing',
    label: 'WhatsApp marketing',
    description: 'Promotions sent via WhatsApp',
    Icon: MessageCircle,
  },
  {
    key: 'sms_marketing',
    label: 'SMS marketing',
    description: 'Promotions sent via text message',
    Icon: MessageSquare,
  },
]

export default function UnsubscribePage({ token, locationId = null }) {
  // UNSUBAUTO.1 — the opt-out fires on ARRIVAL, not on a button press.
  //
  // The previous flow was a GET landing on a confirm button. Measured live on
  // 2026-08-14: 161 contacts had clicked an unsubscribe link and were still
  // mailable, 96 of them more than once, one six times across four days. They
  // clicked "Unsubscribe", saw a page, and closed the tab — which is what
  // "unsubscribe" means to everyone who is not an email engineer.
  //
  // Auto-submitting on GET server-side was rejected: Outlook Safe Links and
  // antivirus scanners issue GETs and would opt people out who never clicked.
  // Firing from a useEffect means it only runs in a real browser that executes
  // JS, which no link scanner does.
  //
  // email_marketing ONLY. They clicked a link in an EMAIL; silently ending
  // their WhatsApp class reminders is not what they asked for. The other two
  // channels stay available on the manual controls.
  const [selected, setSelected] = useState(
    () => new Set(CHANNEL_OPTIONS.map(c => c.key))
  )
  const [status, setStatus] = useState('working')
  const [errorMsg, setErrorMsg] = useState(null)
  const [unsubChannels, setUnsubChannels] = useState([])
  const [resubStatus, setResubStatus] = useState('idle')
  const autoSubmitted = useRef(false)

  useEffect(() => {
    // React 18/19 StrictMode double-invokes effects in dev. The route is
    // idempotent (a repeat opt-out is a 200 no-op) so a second POST is
    // harmless, but the ref keeps the network log honest.
    if (autoSubmitted.current) return
    autoSubmitted.current = true
    submitOptOut(['email_marketing'], { auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function submitOptOut(channels, { auto = false } = {}) {
    if (channels.length === 0) {
      setErrorMsg('Pick at least one channel to unsubscribe from.')
      return
    }
    setStatus('working')
    setErrorMsg(null)
    try {
      // COMMSFIX.A.2 (LOCCOMMS.4) — forward the location scope the email
      // link carried (?l=). The API route resolves scopeLocationId from the
      // POST URL's query; without it every page unsubscribe writes the
      // GLOBAL contact_preferences row and the mig 489 trigger fans the
      // opt-out to every location. No locationId → unchanged global
      // behaviour for old location-less links.
      const scope = locationId ? `?l=${encodeURIComponent(locationId)}` : ''
      const res = await fetch(`/api/unsubscribe/${token}${scope}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels }),
      })
      const data = await res.json()
      if (data.success) {
        setUnsubChannels(prev => [...new Set([...prev, ...(data.unsubscribed_channels || channels)])])
        setStatus('done')
      } else {
        // UNSUBAUTO.1 — a failed AUTO submit must drop the person into the
        // manual flow, never into a success screen. Claiming "you've been
        // unsubscribed" when the write failed is the exact harm this fixes.
        setErrorMsg(data.error || 'Could not process your request.')
        setStatus(auto ? 'idle' : 'error')
      }
    } catch {
      setErrorMsg('Network error — please try again.')
      setStatus(auto ? 'idle' : 'error')
    }
  }

  function handleUnsubscribe() {
    return submitOptOut([...selected])
  }

  // UNSUBAUTO.2 — because the opt-out now happens without a confirmation,
  // undo has to be one press away on the same screen. PUT /api/preferences
  // is the existing opt-in writer; it runs emailStatusNormaliseForOptIn so a
  // bounced address cannot be resurrected by this click.
  async function handleResubscribe() {
    setResubStatus('working')
    try {
      const res = await fetch(`/api/preferences/${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, email_marketing: true }),
      })
      const data = await res.json()
      setResubStatus(data.success ? 'done' : 'error')
    } catch {
      setResubStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-un1t-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-wider mb-8">UN1T</h1>

        {status === 'idle' && (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6 text-left">
            <h2 className="text-lg font-semibold mb-2 text-center">Manage your unsubscribe</h2>
            <p className="text-sm text-un1t-subtle mb-4 text-center">
              Pick which marketing channels you'd like to stop hearing from. Untick anything you want to keep.
            </p>

            <div className="space-y-2 mb-4">
              {CHANNEL_OPTIONS.map(({ key, label, description, Icon }) => {
                const isSelected = selected.has(key)
                return (
                  <label
                    key={key}
                    className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-un1t-text bg-un1t-border/30'
                        : 'border-un1t-border hover:border-un1t-muted'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(key)}
                      className="mt-0.5 accent-un1t-text shrink-0"
                    />
                    <Icon size={16} className="mt-0.5 text-un1t-subtle shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-un1t-text">{label}</div>
                      <div className="text-xs text-un1t-subtle mt-0.5">{description}</div>
                    </div>
                  </label>
                )
              })}
            </div>

            {/* Caveat — explicit per the user's request. We need contacts
                to understand that opting out of marketing doesn't kill
                their booking confirmations / reminders. */}
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 mb-4">
              <p className="text-xs text-amber-200">
                <span className="font-semibold">Heads up:</span> you may still receive
                <strong className="mx-1">utility communication</strong>
                related to your bookings or studio information (confirmations, reminders, schedule changes,
                receipts). To manage those too, use the
                {' '}
                <Link href={`/preferences/${token}`} className="underline">
                  preference centre
                </Link>.
              </p>
            </div>

            {errorMsg && (
              <p className="text-xs text-red-400 mb-3 text-center">{errorMsg}</p>
            )}

            <button
              onClick={handleUnsubscribe}
              disabled={selected.size === 0}
              className="w-full bg-un1t-text text-un1t-bg font-medium py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Unsubscribe from {selected.size} {selected.size === 1 ? 'channel' : 'channels'}
            </button>

            <Link
              href={`/preferences/${token}`}
              className="block mt-3 text-xs text-un1t-subtle hover:text-un1t-text transition-colors text-center"
            >
              Or manage all your communication preferences
            </Link>
          </div>
        )}

        {status === 'working' && (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8">
            <p className="text-un1t-subtle">Processing…</p>
          </div>
        )}

        {status === 'done' && (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <Check size={24} className="text-green-400" />
            </div>
            <h2 className="text-lg font-semibold mb-2">You've been unsubscribed</h2>
            <p className="text-sm text-un1t-subtle mb-3">
              {unsubChannels.length === 0
                ? "You're already opted out of those channels — no changes needed."
                : <>You won't receive marketing on{' '}
                    <span className="text-un1t-text">
                      {unsubChannels.map(c => c.replace('_marketing', '').replace('_', ' ')).join(', ')}
                    </span>
                    {' '}anymore.</>
              }
            </p>
            <p className="text-xs text-un1t-muted mb-4">
              Utility communications (booking confirmations, reminders, schedule changes) will continue.
            </p>
            {resubStatus === 'done' ? (
              <p className="text-sm text-un1t-text mb-3">You're back on the list.</p>
            ) : (
              <button
                type="button"
                onClick={handleResubscribe}
                disabled={resubStatus === 'working'}
                className="text-xs text-un1t-subtle underline hover:text-un1t-text transition-colors mb-3 disabled:opacity-50"
              >
                {resubStatus === 'working' ? 'Working…' : 'Unsubscribed by mistake? Resubscribe'}
              </button>
            )}
            {resubStatus === 'error' && (
              <p className="text-xs text-red-400 mb-3">Could not resubscribe — use the preference centre below.</p>
            )}
            <Link
              href={`/preferences/${token}`}
              className="text-sm text-un1t-subtle hover:text-un1t-text transition-colors"
            >
              Manage all preferences
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8">
            <h2 className="text-lg font-semibold mb-2 text-red-400">Something went wrong</h2>
            <p className="text-sm text-un1t-subtle mb-4">
              {errorMsg || "We couldn't process your request. The link may be invalid or expired."}
            </p>
            <button
              onClick={() => { setStatus('idle'); setErrorMsg(null) }}
              className="text-sm text-un1t-subtle hover:text-un1t-text transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
