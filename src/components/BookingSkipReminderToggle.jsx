'use client'

// Per-booking reminder skip toggle (mig 075). Operator-side: a
// customer asked "please don't remind me about this booking",
// the operator clicks the bell to mute it. Direct DB write —
// no side effects, just metadata the runner reads.
//
// Hidden for past bookings (date in the past) and for bookings
// whose reminder was already sent / skipped (reminder_sent_at
// stamped). After that point the flag is moot.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, BellOff } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { dublinTodayStr } from '@/lib/dublin-time'

export default function BookingSkipReminderToggle({ bookingId, skipReminder, reminderSentAt, bookingDate }) {
  const [skip, setSkip] = useState(!!skipReminder)
  const [busy, setBusy] = useState(false)
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
    const next = !skip
    setSkip(next)
    try {
      const db = createBrowserClient()
      await db.from('bookings').update({ skip_reminder: next }).eq('id', bookingId)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const Icon = skip ? BellOff : Bell
  return (
    <button
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
  )
}
