// CARDLENS.6 — which studio the contact page acts at, for a person the viewer
// shares more than one studio with. Each studio is a ?studio= link: the page
// re-renders with its gates, composer and booking judged there
// (src/lib/contact-acting-studio.js). Server component, no state.
import Link from 'next/link'

const PLATFORM_LABEL = { glofox: 'Glofox', un1t_online: 'un1t.online' }

export default function ActingStudioBar({ options = [], actingId = null }) {
  if (!Array.isArray(options) || options.length < 2) return null
  const acting = options.find((o) => o.locationId === actingId) || null
  const bookings = acting ? (PLATFORM_LABEL[acting.source] || 'the CRM') : null
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 bg-un1t-surface border border-un1t-border rounded-lg px-4 py-2.5">
      <nav aria-label="Act at studio" className="flex flex-wrap gap-1">
        {options.map((o) => {
          const on = o.locationId === actingId
          return (
            <Link
              key={o.locationId}
              href={`?studio=${o.locationId}`}
              aria-current={on ? 'true' : undefined}
              className={`text-xs font-medium px-3 py-1.5 rounded-md border ${on
                ? 'bg-un1t-text text-un1t-bg border-un1t-text'
                : 'bg-un1t-surface text-un1t-text border-un1t-border hover:bg-un1t-bg'}`}
            >
              {o.name}
            </Link>
          )
        })}
      </nav>
      {acting && (
        <p className="text-xs text-un1t-subtle">
          <span className="font-semibold text-un1t-text">Acting at {acting.name}.</span>{' '}
          Messages go from the {acting.name} number, bookings through {bookings}, notes file at {acting.name}.
        </p>
      )}
    </div>
  )
}
