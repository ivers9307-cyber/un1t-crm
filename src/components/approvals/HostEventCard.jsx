'use client'

// APPROVALSQ.4 — the host event card: TeamDecideCard plus the two facts the
// reviewer needs from the event itself, its venue and its price.
import TeamDecideCard from './TeamDecideCard'

export default function HostEventCard({ item, ...rest }) {
  return (
    <TeamDecideCard
      item={item}
      providerKey="host_events"
      {...rest}
      extra={(
        <div className="text-xs text-un1t-subtle flex flex-wrap gap-x-4 gap-y-1">
          <span>Venue: {item.venue || 'No venue'}</span>
          <span>Price: {item.priceLabel || 'Free'}</span>
        </div>
      )}
    />
  )
}
