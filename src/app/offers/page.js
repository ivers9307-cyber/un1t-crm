// /offers — the studio picker (BLACKFRIDAY.3). Each studio has its own
// storefront at /offers/<studio> (src/lib/offer-studios.js); this page only
// points at them, under the default Black Friday hero. It reads nothing.
import Link from 'next/link'
import { OFFER_STUDIOS, DEFAULT_OFFERS_PAGE_COPY } from '@/lib/offer-studios'

export const metadata = {
  title: 'Black Friday — UN1T',
  robots: { index: false, follow: false },
}

export default function OffersPickerPage() {
  const hero = DEFAULT_OFFERS_PAGE_COPY
  const studios = Object.values(OFFER_STUDIOS)
  return (
    <main>
      <div className="ofr-strip" aria-hidden="true">
        <span>{hero.marquee.repeat(4)}</span>
      </div>

      <header style={{ padding: '72px 32px 56px', borderBottom: '1px solid var(--ofr-line)' }}>
        <p className="ofr-display" style={{ fontSize: 15, letterSpacing: '.55em', marginBottom: 52 }}>UN1T</p>
        <h1 className="ofr-display" style={{ fontSize: 'clamp(52px,9vw,104px)', lineHeight: .92, letterSpacing: '-.01em' }}>
          {hero.line1}<br /><span className="ofr-outline">{hero.line2}</span>
        </h1>
        <p style={{ marginTop: 26, maxWidth: '52ch', color: '#b5b5b5', fontSize: 16, lineHeight: 1.6 }}>
          {hero.blurb}
        </p>
      </header>

      <div style={{ padding: '48px 32px 24px' }}>
        <p className="ofr-label">Choose your studio</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', borderTop: '1px solid var(--ofr-line)' }}>
        {studios.map((s) => (
          <Link
            key={s.key}
            href={`/offers/${s.key}`}
            className="ofr-card"
            style={{ minHeight: 260, borderRight: '1px solid var(--ofr-line-soft)', justifyContent: 'space-between' }}
          >
            <span className="ofr-display" style={{ fontSize: 'clamp(36px,4.6vw,56px)', lineHeight: .95 }}>{s.label}</span>
            <span className="ofr-go">See the offers</span>
          </Link>
        ))}
      </div>
    </main>
  )
}
