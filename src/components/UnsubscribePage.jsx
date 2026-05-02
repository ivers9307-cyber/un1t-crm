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

import { useState } from 'react'
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

export default function UnsubscribePage({ token }) {
  // All three pre-selected because the user clicked an "unsubscribe"
  // link — assume they want out of everything unless they say otherwise.
  const [selected, setSelected] = useState(
    () => new Set(CHANNEL_OPTIONS.map(c => c.key))
  )
  const [status, setStatus] = useState('idle')  // idle, loading, done, error
  const [errorMsg, setErrorMsg] = useState(null)
  const [unsubChannels, setUnsubChannels] = useState([])

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleUnsubscribe() {
    if (selected.size === 0) {
      setErrorMsg('Pick at least one channel to unsubscribe from.')
      return
    }
    setStatus('loading')
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/unsubscribe/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: [...selected] }),
      })
      const data = await res.json()
      if (data.success) {
        setUnsubChannels(data.unsubscribed_channels || [...selected])
        setStatus('done')
      } else {
        setErrorMsg(data.error || 'Could not process your request.')
        setStatus('error')
      }
    } catch {
      setErrorMsg('Network error — please try again.')
      setStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-un1t-black flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-wider mb-8">UN1T</h1>

        {status === 'idle' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 text-left">
            <h2 className="text-lg font-semibold mb-2 text-center">Manage your unsubscribe</h2>
            <p className="text-sm text-un1t-light mb-4 text-center">
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
                        ? 'border-un1t-white bg-un1t-gray/30'
                        : 'border-un1t-gray hover:border-un1t-mid'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(key)}
                      className="mt-0.5 accent-un1t-white shrink-0"
                    />
                    <Icon size={16} className="mt-0.5 text-un1t-light shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-un1t-white">{label}</div>
                      <div className="text-xs text-un1t-light mt-0.5">{description}</div>
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
              className="w-full bg-un1t-white text-un1t-black font-medium py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Unsubscribe from {selected.size} {selected.size === 1 ? 'channel' : 'channels'}
            </button>

            <Link
              href={`/preferences/${token}`}
              className="block mt-3 text-xs text-un1t-light hover:text-un1t-white transition-colors text-center"
            >
              Or manage all your communication preferences
            </Link>
          </div>
        )}

        {status === 'loading' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <p className="text-un1t-light">Processing…</p>
          </div>
        )}

        {status === 'done' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <Check size={24} className="text-green-400" />
            </div>
            <h2 className="text-lg font-semibold mb-2">You've been unsubscribed</h2>
            <p className="text-sm text-un1t-light mb-3">
              {unsubChannels.length === 0
                ? "You're already opted out of those channels — no changes needed."
                : <>You won't receive marketing on{' '}
                    <span className="text-un1t-white">
                      {unsubChannels.map(c => c.replace('_marketing', '').replace('_', ' ')).join(', ')}
                    </span>
                    {' '}anymore.</>
              }
            </p>
            <p className="text-xs text-un1t-mid mb-4">
              Utility communications (booking confirmations, reminders, schedule changes) will continue.
            </p>
            <Link
              href={`/preferences/${token}`}
              className="text-sm text-un1t-light hover:text-un1t-white transition-colors"
            >
              Manage all preferences
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <h2 className="text-lg font-semibold mb-2 text-red-400">Something went wrong</h2>
            <p className="text-sm text-un1t-light mb-4">
              {errorMsg || "We couldn't process your request. The link may be invalid or expired."}
            </p>
            <button
              onClick={() => { setStatus('idle'); setErrorMsg(null) }}
              className="text-sm text-un1t-light hover:text-un1t-white transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
