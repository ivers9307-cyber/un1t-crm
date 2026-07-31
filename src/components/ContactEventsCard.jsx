// Events on the contact profile (HOST-MASTER.6) — the contact's race-event
// registrations (host + internal), resolved live from team_members →
// teams → race_registrations (same join as /api/contacts/[id]/events).
// Server-compatible presentational component; renders nothing when the
// contact has none. Matches the sibling event-card idiom
// (EventRegistrationsCards.jsx): raw surface div + uppercase h3, light-theme
// chip recipe bg-<c>-500/10 text-<c>-700.

import Link from 'next/link'

const STATUS_CHIP = {
  confirmed: 'bg-emerald-500/10 text-emerald-700',
  cancelled: 'bg-red-500/10 text-red-700',
  no_show: 'bg-amber-500/10 text-amber-700',
}

export default function ContactEventsCard({ events }) {
  if (!events || events.length === 0) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">Events</h3>
      <ul>
        {events.map((e) => (
          <li key={e.id} className="py-2.5 flex items-center justify-between gap-3 border-b border-un1t-border last:border-0">
            <div className="min-w-0">
              {/* e.id = registration id (unique key); e.eventId = race_events.id (link). */}
              <Link href={`/events/${e.eventId}`} className="text-sm font-medium hover:underline truncate block">
                {e.name}
              </Link>
              <p className="text-xs text-un1t-muted mt-0.5">
                {e.race_date
                  ? new Date(e.race_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
                  : '—'}
                {e.hostName ? ` · Hosted by ${e.hostName}` : ''}
              </p>
            </div>
            {e.status && (
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CHIP[e.status] || 'bg-gray-500/10 text-gray-700'}`}>
                {e.status === 'no_show' ? 'no show' : e.status}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
