// HOSTSTATS.1 — the Signups card: how many saw the page, how many booked,
// where they came from, and how the waitlist is going. Pure render (server
// or client); `dark` for the host portal's black theme, light for staff.
//
// The figures are operator-facing (a host or a staff member), so plain
// literals are fine. `stats` null = the lib could not read: say so rather
// than show zeros that look like an answer.

export default function EventSignupsCard({ stats, dark = false }) {
  const shell = dark
    ? 'rounded-xl border border-white/10 bg-white/[0.02] p-4 text-white'
    : 'rounded-lg border border-un1t-border bg-un1t-surface p-4 text-un1t-text'
  const heading = dark ? 'text-xs uppercase tracking-[0.15em] text-white/45' : 'text-[11px] uppercase tracking-wider text-un1t-subtle'
  const muted = dark ? 'text-white/50' : 'text-un1t-subtle'
  const figure = dark ? 'text-2xl font-semibold text-white' : 'text-2xl font-semibold text-un1t-text'

  if (!stats) {
    return (
      <section aria-label="Signups" className={`mt-6 ${shell}`}>
        <h2 className={heading}>Signups</h2>
        <p className={`mt-2 text-sm ${muted}`}>Signup stats unavailable right now.</p>
      </section>
    )
  }

  const conversion = stats.conversion_pct === null || stats.conversion_pct === undefined ? '—' : `${stats.conversion_pct}%`
  const wl = stats.waitlist || { waiting: 0, offered: 0, claimed: 0 }
  const showWaitlist = (wl.waiting || 0) + (wl.offered || 0) + (wl.claimed || 0) > 0
  const sources = Array.isArray(stats.by_source) ? stats.by_source : []

  return (
    <section aria-label="Signups" className={`mt-6 ${shell}`}>
      <h2 className={heading}>Signups</h2>
      <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Page views" value={stats.views} figure={figure} muted={muted} />
        <Figure label="Visitors" value={stats.unique_visitors} figure={figure} muted={muted} />
        <Figure label="Booked" value={stats.confirmed} figure={figure} muted={muted} />
        <Figure label="Conversion" value={conversion} figure={figure} muted={muted} />
      </dl>
      {sources.length > 0 && (
        <div className="mt-4">
          <h3 className={`text-xs ${muted}`}>Where they came from</h3>
          <ul className="mt-1.5 divide-y divide-current/10 text-sm">
            {sources.map((s) => (
              <li key={s.source} className="flex items-center justify-between gap-3 py-1.5">
                <span className="truncate">{s.label || s.source}</span>
                <span className={`shrink-0 tabular-nums text-xs ${muted}`}>
                  {s.views} view{s.views === 1 ? '' : 's'} · {s.booked} booked
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showWaitlist && (
        <p className={`mt-4 text-sm ${muted}`}>
          Waitlist: {wl.waiting} waiting · {wl.offered} offered · {wl.claimed} booked from the list
        </p>
      )}
      {stats.capped && (
        <p className={`mt-2 text-xs ${muted}`}>Counts are capped: the event has more rows than this card reads.</p>
      )}
    </section>
  )
}

function Figure({ label, value, figure, muted }) {
  return (
    <div>
      <dt className={`text-xs ${muted}`}>{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${figure}`}>{value}</dd>
    </div>
  )
}
