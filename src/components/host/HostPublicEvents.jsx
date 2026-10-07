// HOST-EVENTS-PAGE.1 — the host's public events section on /h/[slug]: a
// host-branded hero (image + accent) and a grid of upcoming-event cards,
// each linking to the existing /event/[slug] page to book and pay. Server
// component; dark like the rest of the public surfaces. Cards carry date,
// time, venue, price and a "Sold out" (red, white text — Richard, 7 Oct) /
// "Opens <date>" badge — never a count or a capacity (that boolean is all
// that leaves the server).
import Link from 'next/link'

export default function HostPublicEvents({ hostName, headline, blurb, heroUrl, accentHex, cards }) {
  const accent = accentHex || '#ffffff'
  return (
    <section className="w-full">
      <header className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03]">
        {heroUrl && (
          <div
            aria-hidden
            className="absolute inset-0 bg-cover bg-center opacity-50"
            style={{ backgroundImage: `url(${JSON.stringify(heroUrl)})` }}
          />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />
        <div className="relative px-6 py-14 sm:px-10 sm:py-20">
          <p className="mb-3 text-xs uppercase tracking-[0.2em] text-white/60">{hostName}</p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{headline}</h1>
          {blurb && <p className="mt-4 max-w-2xl text-base text-white/75">{blurb}</p>}
          <div aria-hidden className="mt-6 h-1 w-16 rounded-full" style={{ backgroundColor: accent }} />
        </div>
      </header>

      {(!cards || cards.length === 0) ? (
        <div className="mt-8 rounded-2xl border border-white/15 p-10 text-center text-white/60">
          <p className="mb-2 text-lg font-semibold text-white">No upcoming events right now</p>
          <p className="text-sm">Join the list below and you&rsquo;ll hear first when the next one opens.</p>
        </div>
      ) : (
        <ul className="mt-8 grid gap-5 sm:grid-cols-2">
          {cards.map((c) => {
            const soldOut = c.badge === 'Sold out'
            return (
              <li key={c.slug}>
                <Link
                  href={`/event/${c.slug}`}
                  className="group block h-full rounded-2xl border border-white/15 p-6 transition-colors hover:border-white/40"
                >
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <span className="rounded-full border border-white/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/70">{c.kindLabel}</span>
                    {c.badge && (
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${soldOut ? 'bg-red-600 text-white' : 'bg-white/15 text-white'}`}>{c.badge}</span>
                    )}
                  </div>
                  <p className="mb-1 text-xs text-white/55">
                    {c.dateLabel}{c.timeLabel ? ` · ${c.timeLabel}` : ''}{c.venue ? ` · ${c.venue}` : ''}
                  </p>
                  <h2 className="mb-4 text-xl font-semibold transition-transform group-hover:translate-x-0.5">{c.title}</h2>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white/70">{c.priceLabel}</span>
                    <span className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: soldOut ? undefined : accent }}>
                      {soldOut ? 'View' : 'View & book'} <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
                    </span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
