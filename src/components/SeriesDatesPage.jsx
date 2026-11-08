// SeriesDatesPage — HOSTSERIES.1: the series page body. Hero (first upcoming
// date's image + accent, the series headline and blurb) and one card per
// published upcoming date, each linking to its own signup page unless its
// registration has closed. Server component; dark like every public surface.
// Never a count or a capacity: the sold-out boolean is all that arrives.
import Link from 'next/link'

export default function SeriesDatesPage({ eyebrow, headline, blurb, heroUrl, accentHex, cards }) {
  const accent = accentHex || '#ffffff'
  const list = Array.isArray(cards) ? cards : []
  return (
    <section className="w-full">
      <header className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03]">
        {heroUrl && (
          <div aria-hidden className="absolute inset-0 bg-cover bg-center opacity-50" style={{ backgroundImage: `url(${JSON.stringify(heroUrl)})` }} />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />
        <div className="relative px-6 py-14 sm:px-10 sm:py-20">
          {eyebrow && <p className="mb-3 text-xs uppercase tracking-[0.2em] text-white/60">{eyebrow}</p>}
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{headline}</h1>
          {blurb && <p className="mt-4 max-w-2xl text-base text-white/75">{blurb}</p>}
          <div aria-hidden className="mt-6 h-1 w-16 rounded-full" style={{ backgroundColor: accent }} />
        </div>
      </header>

      {list.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-white/15 p-10 text-center text-white/60">
          <p className="mb-2 text-lg font-semibold text-white">No dates are open right now</p>
          <p className="text-sm">Check back soon.</p>
        </div>
      ) : (
        <ul className="mt-8 grid gap-5 sm:grid-cols-2">
          {list.map((c) => {
            const soldOut = c.badge === 'Sold out'
            const body = (
              <>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <span className="rounded-full border border-white/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/70">{c.kindLabel}</span>
                  {c.badge && (
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${soldOut || c.closed ? 'bg-red-600 text-white' : 'bg-white/15 text-white'}`}>{c.badge}</span>
                  )}
                </div>
                <p className="mb-1 text-lg font-semibold">{c.dateLabel}{c.timeLabel ? ` · ${c.timeLabel}` : ''}</p>
                <p className="mb-4 text-sm text-white/60">{c.title}{c.venue ? ` · ${c.venue}` : ''}</p>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/70">{c.priceLabel}</span>
                  {c.href && (
                    <span className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: soldOut ? undefined : accent }}>
                      {soldOut ? 'View' : 'View & book'} <span aria-hidden>→</span>
                    </span>
                  )}
                </div>
              </>
            )
            return (
              <li key={c.slug}>
                {c.href ? (
                  <Link href={c.href} className="group block h-full rounded-2xl border border-white/15 p-6 transition-colors hover:border-white/40">{body}</Link>
                ) : (
                  <div className="block h-full rounded-2xl border border-white/10 p-6 opacity-70">{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
