// Public events listing body — hero + a grid of upcoming-event cards, each
// linking to the existing /event/[slug] booking. Server component; styled to
// match the un1tdublin.com marketing layer (black bg, white text, lp-reveal).
import Link from 'next/link'

export default function PublicEventsList({ studioName, cards }) {
  return (
    <main className="min-h-screen bg-black text-white px-5 sm:px-8 py-16 sm:py-24">
      <div className="max-w-5xl mx-auto">
        <header className="mb-12 lp-reveal">
          <p className="text-xs uppercase tracking-[0.2em] text-white/45 mb-3">Upcoming events</p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">What&rsquo;s on at {studioName}</h1>
        </header>

        {(!cards || cards.length === 0) ? (
          <div className="lp-reveal border border-white/15 rounded-2xl p-10 text-center text-white/60">
            <p className="text-lg font-semibold text-white mb-2">No upcoming events right now</p>
            <p className="text-sm">Check back soon — new races, workshops and open days drop regularly.</p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {cards.map((c, i) => (
              <Link
                key={c.slug}
                href={`/event/${c.slug}`}
                className={`lp-reveal lp-d${(i % 3) + 1} group block border border-white/15 rounded-2xl p-6 hover:border-white/40 transition-colors`}
              >
                <div className="flex items-center justify-between gap-3 mb-4">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-white/70 border border-white/20 rounded-full px-2.5 py-1">{c.kindLabel}</span>
                  {c.badge && (
                    <span className={`text-[11px] font-semibold rounded-full px-2.5 py-1 ${c.badge === 'Sold out' ? 'bg-white/10 text-white/50' : 'bg-white/15 text-white'}`}>{c.badge}</span>
                  )}
                </div>
                <p className="text-xs text-white/55 mb-1">{c.dateLabel}</p>
                <h2 className="text-xl font-semibold mb-4 group-hover:translate-x-0.5 transition-transform">{c.title}</h2>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/70">{c.priceLabel}</span>
                  <span className="text-sm font-semibold inline-flex items-center gap-1">View &amp; book <span aria-hidden className="group-hover:translate-x-1 transition-transform">→</span></span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
