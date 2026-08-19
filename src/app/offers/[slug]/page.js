// /offers/[slug] — sale offer product page (OFFERS.7). Left: the offer at
// display scale + what's included. Right: price + buyer form + embedded
// Revolut checkout (OfferCheckout). Closed sale renders a sale-ended panel
// in place of the form; unknown slug 404s.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { offerIsOpen, offerHasDeadline, formatEuro, formatSaleDeadline } from '@/lib/sale-offers'
import SaleCountdown from '@/components/offers/SaleCountdown'
import OfferCheckout from '@/components/offers/OfferCheckout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function includesFor(offer) {
  // GIFTCARD.1 — a gift card is a value, not a product with a term. It must
  // NOT claim classes are being added to the buyer's own account (the
  // membership/pack copy below does), and the 5-year validity is stated
  // because Irish law (Consumer Protection (Gift Vouchers) Act 2019) sets a
  // 5-year minimum and the buyer is entitled to know it before paying.
  if (offer.category === 'gift_card') {
    return [
      offer.description,
      'Spend it on any membership, class pack or drop-in at UN1T Stillorgan',
      'Valid for 5 years from the date of purchase',
      'We email you the gift card details within 24 hours, ready to hand over',
    ]
  }
  if (offer.category === 'membership') {
    return [
      'Unlimited coached 45-minute classes, 7 days a week',
      offer.description,
      'The €100 discount is already included in the price',
      'We set you up within 24 hours of purchase',
    ]
  }
  return [
    offer.description,
    'Book onto any class on the Stillorgan timetable',
    'We add your classes within 24 hours of purchase',
  ]
}

export default async function OfferPage(props) {
  const { slug } = await props.params
  const sp = await props.searchParams
  // Revolut's redirect back after an app-handoff payment carries ?purchase=
  // (set by the checkout route's redirectUrl) — resume in confirming mode.
  const resumePurchaseId = typeof sp?.purchase === 'string' ? sp.purchase : null
  const db = createServerClient()
  const { data: offer } = await db.from('sale_offers').select('*').eq('slug', slug).maybeSingle()
  if (!offer) notFound()

  const open = offerIsOpen(offer)
  const isGift = offer.category === 'gift_card'
  const [titleTop, ...titleRest] = offer.name.split(' ')
  const priceLabel = formatEuro(offer.price_cents)
  const was = offer.category === 'membership' ? formatEuro(offer.price_cents + 10000) : null

  return (
    <main style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', minHeight: 560 }}>
      <div style={{ padding: '64px 32px', borderRight: '1px solid var(--ofr-line)' }}>
        <p style={{ fontSize: 11, letterSpacing: '.3em', textTransform: 'uppercase', color: '#777', marginBottom: 38 }}>
          <Link href="/offers" style={{ color: 'inherit', textDecoration: 'none' }}>← All offers</Link>
          &nbsp;·&nbsp; UN1T Stillorgan
        </p>
        <h1 className="ofr-display" style={{ fontSize: 'clamp(40px,6vw,72px)', lineHeight: .95 }}>
          {titleTop}<br />{titleRest.join(' ')}
        </h1>
        {!isGift && (
          <p className="ofr-display ofr-outline" style={{ marginTop: 6, fontSize: 'clamp(40px,6vw,72px)', lineHeight: .95 }}>
            {offer.bonus_headline}
          </p>
        )}
        {open && offerHasDeadline(offer) && (
          <div className="ofr-deadline">
            <b>Sale ends</b>
            <SaleCountdown endsAt={offer.ends_at} />
          </div>
        )}
        <ul className="ofr-includes" style={{ marginTop: 44, borderTop: '1px solid var(--ofr-line-soft)', padding: 0 }}>
          {includesFor(offer).filter(Boolean).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>

      <div style={{ padding: '64px 32px', background: '#0d0d0d', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 18 }}>
          <span className="ofr-display" style={{ fontSize: 56, fontVariantNumeric: 'tabular-nums', display: 'block' }}>{priceLabel}</span>
          {was && <span className="ofr-was">{was}</span>}
        </div>
        {open ? (
          <OfferCheckout slug={offer.slug} priceLabel={priceLabel} resumePurchaseId={resumePurchaseId} />
        ) : (
          <div style={{ paddingTop: 24 }}>
            <p className="ofr-display" style={{ fontSize: 28 }}>
              {offerHasDeadline(offer) ? 'The sale has ended' : 'Not available right now'}
            </p>
            <p style={{ color: '#9a9a9a', marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>
              {offerHasDeadline(offer)
                ? `This offer closed on ${formatSaleDeadline(offer.ends_at, { uppercase: false })}. Keep an eye on your inbox for the next one.`
                : 'This one is off sale at the moment. Get in touch and we will sort you out.'}
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
