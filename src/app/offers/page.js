// /offers — weekend "lock in" sale landing (OFFERS.7). Server-rendered from
// sale_offers; memberships as a 3-up column grid, class packs 2-up, section
// titles at display scale, countdown in red. Card copy is data-driven off
// the seeded rows (mig 503) so price/bonus/date edits need no deploy.
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { offerIsOpen, formatEuro } from '@/lib/sale-offers'
import SaleCountdown from '@/components/offers/SaleCountdown'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Slug → big-numeral term for the card headers.
function termFor(offer) {
  if (offer.slug === '1-year-membership') return { num: '12', label: 'MONTHS' }
  const m = offer.slug.match(/^(\d+)-month/)
  if (m) return { num: m[1], label: 'MONTHS' }
  const c = offer.slug.match(/^(\d+)-class/)
  if (c) return { num: c[1], label: 'CLASSES' }
  return { num: '', label: offer.name }
}

const FLAGS = {
  '1-year-membership': 'Biggest bonus',
  '30-class-pack': 'Biggest pack bonus',
}

function OfferCard({ offer }) {
  const term = termFor(offer)
  const flag = FLAGS[offer.slug]
  const was = offer.category === 'membership' ? offer.price_cents + 10000 : null
  return (
    <Link
      href={`/offers/${offer.slug}`}
      className="ofr-card"
      style={{ minHeight: 400, borderRight: '1px solid var(--ofr-line-soft)' }}
    >
      {flag && <span className="ofr-flag">{flag}</span>}
      <span className="ofr-display" style={{ fontSize: 'clamp(44px,5vw,64px)', lineHeight: .9 }}>
        {term.num}
        <small style={{ display: 'block', fontSize: 15, letterSpacing: '.3em', marginTop: 8 }}>{term.label}</small>
      </span>
      <span className="ofr-display ofr-outline-thin" style={{ fontSize: 'clamp(22px,2.6vw,30px)', lineHeight: 1 }}>
        {offer.bonus_headline}
      </span>
      <p className="ofr-meta">{offer.description}</p>
      <span>
        <span className="ofr-display" style={{ fontSize: 'clamp(30px,3.4vw,42px)', fontVariantNumeric: 'tabular-nums', display: 'block' }}>
          {formatEuro(offer.price_cents)}
        </span>
        {was && <span className="ofr-was">{formatEuro(was)}</span>}
      </span>
      <span className="ofr-go">Lock it in</span>
    </Link>
  )
}

function SectionHead({ idx, title, tag }) {
  return (
    <div style={{ padding: '64px 32px 30px', borderBottom: '1px solid var(--ofr-line)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '10px 24px' }}>
      <span className="ofr-display" style={{ fontSize: 14, letterSpacing: '.3em', color: '#666', transform: 'translateY(-1.6em)' }}>{idx}</span>
      <h2 className="ofr-display" style={{ fontSize: 'clamp(38px,6vw,68px)', lineHeight: .95, letterSpacing: '-.01em' }}>{title}</h2>
      <span style={{ fontSize: 12, color: '#8a8a8a', letterSpacing: '.18em', textTransform: 'uppercase', marginLeft: 'auto' }}>{tag}</span>
    </div>
  )
}

export default async function OffersPage() {
  const db = createServerClient()
  const { data } = await db
    .from('sale_offers')
    .select('*')
    .eq('active', true)
    .order('sort', { ascending: true })
  const offers = (data || []).filter((o) => offerIsOpen(o))
  const memberships = offers.filter((o) => o.category === 'membership')
  const packs = offers.filter((o) => o.category === 'class_pack')
  const endsAt = offers[0]?.ends_at || null

  return (
    <main>
      <div className="ofr-strip" aria-hidden="true">
        <span>{'ENDS MIDNIGHT MONDAY · LOCK IN YOUR MEMBERSHIP · '.repeat(4)}</span>
      </div>

      <header style={{ padding: '72px 32px 56px', borderBottom: '1px solid var(--ofr-line)' }}>
        <p className="ofr-display" style={{ fontSize: 15, letterSpacing: '.55em', marginBottom: 52 }}>UN1T STILLORGAN</p>
        <h1 className="ofr-display" style={{ fontSize: 'clamp(52px,9vw,104px)', lineHeight: .92, letterSpacing: '-.01em' }}>
          LOCK IN YOUR<br /><span className="ofr-outline">MEMBERSHIP</span>
        </h1>
        <p style={{ marginTop: 26, maxWidth: '52ch', color: '#b5b5b5', fontSize: 16, lineHeight: 1.6 }}>
          Five offers. One weekend. Every plan comes with extra time or extra classes on the house. Pay once, train more, done.
        </p>
        {endsAt && (
          <div className="ofr-deadline">
            <b>Sale ends</b>
            <SaleCountdown endsAt={endsAt} />
          </div>
        )}
      </header>

      {offers.length === 0 ? (
        <div style={{ padding: '80px 32px', textAlign: 'center' }}>
          <p className="ofr-display" style={{ fontSize: 32 }}>The sale has ended</p>
          <p style={{ color: '#9a9a9a', marginTop: 12 }}>Keep an eye on your inbox — we&rsquo;ll let you know when the next one opens.</p>
        </div>
      ) : (
        <>
          <SectionHead idx="01" title="Memberships" tag="Paid upfront · €100 off included" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            {memberships.map((o) => <OfferCard key={o.id} offer={o} />)}
          </div>

          <SectionHead idx="02" title="Class Packs" tag="Stock up · train on your schedule" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            {packs.map((o) => <OfferCard key={o.id} offer={o} />)}
          </div>
        </>
      )}
    </main>
  )
}
