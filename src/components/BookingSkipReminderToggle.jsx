'use client'

// Per-booking reminder skip toggle (mig 075). Operator-side: a
// customer asked "please don't remind me about this booking",
// the operator clicks the bell to mute it. No side effects, just
// metadata the runner reads. C134 WEBBOOKINGWRITES.1: written through
// POST /api/bookings/[id]/skip-reminder (the WEB `bookings` key at the
// booking's studio), no longer the browser client, whose RLS judged the
// PHONE key; a failure puts the bell back and says so.
//
// Hidden for past bookings (date in the past) and for bookings
// whose reminder was already sent / skipped (reminder_sent_at
// stamped). After that point the flag is moot.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, BellOff } from 'lucide-react'
import { dublinTodayStr } from '@/lib/dublin-time'

const SKIP_FAILED = 'Could not change the reminder setting. Try again.'

export default function BookingSkipReminderToggle({ bookingId, skipReminder, reminderSentAt, bookingDate }) {
  const [skip, setSkip] = useState(!!skipReminder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const router = useRouter()

  // Hide the toggle once the runner has already acted on this
  // booking. Either the reminder went out, or it was previously
  // skipped — either way, flipping the flag now changes nothing.
  if (reminderSentAt) return null

  // Hide for past bookings — the time has gone, reminders aren't
  // relevant. Cleaner than showing a no-op control.
  const today = dublinTodayStr()
  if (bookingDate && bookingDate < today) return null

  async function toggle() {
    setBusy(true)
    setError(null)
    const next = !skip
    setSkip(next)
    try {
      const res = await fetch(`/api/bookings/${bookingId}/skip-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_reminder: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        setSkip(!next)
        setError(data?.error || SKIP_FAILED)
        return
      }
      router.refresh()
    } catch {
      setSkip(!next)
      setError(SKIP_FAILED)
    } finally {
      setBusy(false)
    }
  }

  const Icon = skip ? BellOff : Bell
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={skip
          ? 'Reminder skipped — click to re-enable'
          : 'Reminder enabled — click to skip for this booking only'}
        className={`p-1.5 rounded-md transition-colors ${
          skip
            ? 'text-amber-700 bg-amber-500/10 hover:bg-amber-500/20'
            : 'text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/40'
        } disabled:opacity-50`}
      >
        <Icon size={14} />
      </button>
      {error && (
        <span role="alert" className="absolute right-0 top-full mt-1 z-10 w-56 text-right text-[11px] text-red-700 bg-un1t-surface">{error}</span>
      )}
    </span>
  )
}
