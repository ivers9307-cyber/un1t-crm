// CC.2 — CRM-native event-registration cards (workshops, masterclasses,
// open days, races — the /events flow), moved verbatim from the old
// Activity tab. Distinct from Glofox class bookings, which live in the
// Glofox Profile card. Upcoming renders in the what's-next rail; past
// in the centre history column.

import { formatTime } from './format'

const bookingStatusColors = {
  confirmed: 'bg-blue-500/20 text-blue-700',
  completed: 'bg-green-500/20 text-green-700',
  cancelled: 'bg-red-500/20 text-red-700',
  no_show: 'bg-yellow-500/20 text-yellow-700',
}

export function UpcomingEventsCard({ bookings }) {
  if (bookings.length === 0) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Upcoming event registrations</h3>
      {bookings.map(b => (
        <div key={b.id} className="flex items-start gap-3 py-2 border-b border-un1t-border last:border-0">
          <div
            className="w-1 h-8 rounded-full mt-0.5 shrink-0"
            style={{ backgroundColor: b.event_types?.color || '#6B7280' }}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{b.event_types?.name || 'Event'}</p>
            <p className="text-xs text-un1t-subtle mt-0.5">
              {new Date(b.booking_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })}
              {' · '}
              {formatTime(b.start_time)} — {formatTime(b.end_time)}
            </p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${bookingStatusColors[b.status]}`}>
            {b.status}
          </span>
        </div>
      ))}
    </div>
  )
}

export function PastEventsCard({ bookings }) {
  if (bookings.length === 0) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Past event registrations</h3>
      {bookings.map(b => (
        <div key={b.id} className="flex items-start gap-3 py-2 border-b border-un1t-border last:border-0 opacity-60">
          <div
            className="w-1 h-8 rounded-full mt-0.5 shrink-0"
            style={{ backgroundColor: b.event_types?.color || '#6B7280' }}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm">{b.event_types?.name || 'Event'}</p>
            <p className="text-xs text-un1t-subtle mt-0.5">
              {new Date(b.booking_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}
              {' · '}
              {formatTime(b.start_time)}
            </p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${bookingStatusColors[b.status]}`}>
            {b.status}
          </span>
        </div>
      ))}
    </div>
  )
}
