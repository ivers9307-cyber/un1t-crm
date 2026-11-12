// /offers/[studio]/[slug] — one studio's sale offer product page (OFFERS.7,
// per studio since BLACKFRIDAY.3). Left: the offer at display scale + what's
// included. Right: price + buyer form + checkout (OfferCheckout). An offer
// that opens later shows its opening date in place of the form; a closed one
// renders the sale-ended panel; an unknown studio or slug 404s.
//
// The row is looked up by (location_id, slug): a slug alone is not unique
// since mig 827. An offer with un1t_product_id is sold through un1t.online
// (Hatch Street), which needs its terms and waiver tick; the rest ride Revolut.
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { offerIsOpen, offerIsUpcoming, offerHasDeadline, formatEuro, formatSaleDeadline } from '@/lib/sale-offers'
import { resolveOfferStudio } from '@/lib/offer-studios'
import { studioTermsCopy } from '@/lib/landing-pages'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import SaleCountdown from '@/components/offers/SaleCountdown'
import OfferCheckout from '@/components/offers/OfferCheckout'
import { displayZoneFor } from '@/lib/display-zone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function includesFor(offer, studio) {
  const finePrint = typeof offer.fine_print === 'string' && offer.fine_print.trim() ? offer.fine_print : null
  // GIFTCARD.1 — a gift card is a value, not a product with a term. It must
  // NOT claim classes are being added to the buyer's own account (the
  // membership/pack copy below does), and the 5-year validity is stated
  // because Irish law (Consumer Protection (Gift Vouchers) Act 2019) sets a
  // 5-year minimum and the buyer is entitled to know it before paying.
  // BLACKFRIDAY.3 — a gift with its own fine print states its own terms, so
  // the generic spend and validity lines give way to it.
  if (offer.category === 'gift_card') {
    return [
      offer.description,
      !finePrint && `Spend it on any membership, class pack or drop-in at ${studio.label}`,
      !finePrint && 'Valid for 5 years from the date of purchase',
      'We email you the gift card details within 24 hours, ready to hand over',
      finePrint,
    ]
  }
  if (offer.category === 'membership') {
    return [
      'Unlimited coached 45-minute classes, 7 days a week',
      offer.description,
      'We set you up within 24 hours of purchase',
      finePrint,
    ]
  }
  return [
    offer.description,
    `Book onto any class on the ${studio.label} timetable`,
    'We add your classes within 24 hours of purchase',
    finePrint,
  ]
}

export default async function OfferPage(props) {
  const { studio: key, slug } = await props.params
  const sp = await props.searchParams
  // Revolut's redirect back after an app-handoff payment carries ?purchase=
  // (set by the checkout route's redirectUrl) — resume in confirming mode.
  const resumePurchaseId = typeof sp?.purchase === 'string' ? sp.purchase : null
  const db = createServerClient()
  const resolved = await resolveOfferStudio(db, key)
  if (!resolved) notFound()
  const { studio, location } = resolved
  const { data: offer, error } = await db
    .from('sale_offers')
    .select('*')
    .eq('location_id', location.id)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  if (!offer) notFound()
  // TZ.16 — the studio's clock for the opening and closing dates (display only).
  const zone = await displayZoneFor(db, null, location.id, 'offers')

  const now = new Date()
  const open = offerIsOpen(offer, now)
  const upcoming = offerIsUpcoming(offer, now)
  const isGift = offer.category === 'gift_card'
  const [titleTop, ...titleRest] = offer.name.split(' ')
  const priceLabel = formatEuro(offer.price_cents)
  const provider = offer.un1t_product_id ? 'un1t_online' : 'revolut'
  // un1t.online's terms and waiver tick, in the studio page's own words. The
  // legal links take the studio page's public path, which is the studio key.
  const terms = provider === 'un1t_online'
    ? un1tTermsPayload({ terms: await studioTermsCopy(db, location.id), studioName: location.name, publicPath: studio.key })
    : null

  return (
    <main style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', minHeight: 560 }}>
      <div style={{ padding: '64px 32px', borderRight: '1px solid var(--ofr-line)' }}>
        <p style={{ fontSize: 11, letterSpacing: '.3em', textTransform: 'uppercase', color: '#777', marginBottom: 38 }}>
          <Link href={`/offers/${studio.key}`} style={{ color: 'inherit', textDecoration: 'none' }}>← All offers</Link>
          &nbsp;·&nbsp; {studio.label}
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
        {upcoming && (
          <div className="ofr-deadline">
            <b>Opens</b>
            <SaleCountdown endsAt={offer.starts_at} doneLabel="NOW OPEN" />
          </div>
        )}
        <ul className="ofr-includes" style={{ marginTop: 44, borderTop: '1px solid var(--ofr-line-soft)', padding: 0 }}>
          {includesFor(offer, studio).filter(Boolean).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>

      <div style={{ padding: '64px 32px', background: '#0d0d0d', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 18 }}>
          <span className="ofr-display" style={{ fontSize: 56, fontVariantNumeric: 'tabular-nums', display: 'block' }}>{priceLabel}</span>
        </div>
        {open ? (
          <OfferCheckout
            studio={studio.key}
            slug={offer.slug}
            priceLabel={priceLabel}
            provider={provider}
            terms={terms}
            resumePurchaseId={resumePurchaseId}
          />
        ) : upcoming ? (
          <div style={{ paddingTop: 24 }}>
            <p className="ofr-display" style={{ fontSize: 28 }}>
              Opens {formatSaleDeadline(offer.starts_at, { uppercase: false, zone })}
            </p>
            <p style={{ color: '#9a9a9a', marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>
              Come back when it opens to lock it in.
            </p>
          </div>
        ) : (
          <div style={{ paddingTop: 24 }}>
            <p className="ofr-display" style={{ fontSize: 28 }}>
              {offerHasDeadline(offer) ? 'The sale has ended' : 'Not available right now'}
            </p>
            <p style={{ color: '#9a9a9a', marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>
              {offerHasDeadline(offer)
                ? `This offer closed on ${formatSaleDeadline(offer.ends_at, { uppercase: false, zone })}. Keep an eye on your inbox for the next one.`
                : 'This one is off sale at the moment. Get in touch and we will sort you out.'}
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
