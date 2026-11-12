// /offers/[studio] — one studio's storefront (BLACKFRIDAY.3; the single
// Stillorgan storefront of OFFERS.7 / GIFTCARD.1 before it).
//
// The storefront is driven by the CATEGORY of whatever is active in that
// studio's sale_offers rows, because the same rail sells two very different
// things:
//   * a TIMED SALE (membership / class_pack) — bonus headline, countdown;
//   * an EVERGREEN product (gift_card) — no deadline, no bonus, no discount.
// Rows that open later (the Black Friday head start) are listed too, with
// their opening date, and stay links: the product page says when it opens.
//
// A key that is not a studio is a pre-BLACKFRIDAY link (/offers/<slug>, in
// sent emails and Revolut's redirect URLs). Every one of those was
// Stillorgan's, so a Stillorgan row with that slug redirects to its page,
// keeping ?purchase= so the payment confirmation resumes; anything else 404s.
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { offerIsUpcoming, formatEuro, formatSaleDeadline } from '@/lib/sale-offers'
import { resolveOfferStudio, studioForKey, offersPageCopy } from '@/lib/offer-studios'
import { heroFor, CATEGORY_ORDER, storefrontOffers, storefrontCountdown, isCyberMondayOnly, termForSlug, flagForSlug, offerFinePrint } from '@/lib/offers-storefront'
import { legacyOfferRedirect } from '@/lib/offers-legacy-redirect'
import { displayZoneFor } from '@/lib/display-zone'
import SaleCountdown from '@/components/offers/SaleCountdown'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CATEGORY_META = {
  gift_card:  { title: 'Gift Cards',  tag: 'Give the gift of training' },
  membership: { title: 'Memberships', tag: 'Bonus time on the house' },
  class_pack: { title: 'Class Packs', tag: 'Stock up · train on your schedule' },
}
// Display order + hero copy: src/lib/offers-storefront.js (OFFERS.8).

// The big numeral at the top of a card. For a gift card the VALUE is the
// headline — there is no term to state.
function termFor(offer) {
  if (offer.category === 'gift_card') {
    return { num: formatEuro(offer.price_cents), label: 'GIFT CARD' }
  }
  const t = termForSlug(offer.slug)
  if (t) return t
  return { num: '', label: offer.name }
}

function OfferCard({ offer, studio, flag, opensLabel }) {
  const term = termFor(offer)
  const isGift = offer.category === 'gift_card'
  // BLACKFRIDAY.9 — any studio's offer shows its own fine print when it has some.
  const finePrint = offerFinePrint(offer)
  return (
    <Link
      href={`/offers/${studio.key}/${offer.slug}`}
      className="ofr-card"
      style={{ minHeight: isGift ? 340 : 400, borderRight: '1px solid var(--ofr-line-soft)' }}
    >
      {flag && <span className="ofr-flag">{flag}</span>}
      <span className="ofr-display" style={{ fontSize: 'clamp(44px,5vw,64px)', lineHeight: .9 }}>
        {term.num}
        <small style={{ display: 'block', fontSize: 15, letterSpacing: '.3em', marginTop: 8 }}>{term.label}</small>
      </span>
      {!isGift && (
        <span className="ofr-display ofr-outline-thin" style={{ fontSize: 'clamp(22px,2.6vw,30px)', lineHeight: 1 }}>
          {offer.bonus_headline}
        </span>
      )}
      <p className="ofr-meta">{offer.description}</p>
      {!isGift && (
        <span>
          <span className="ofr-display" style={{ fontSize: 'clamp(30px,3.4vw,42px)', fontVariantNumeric: 'tabular-nums', display: 'block' }}>
            {formatEuro(offer.price_cents)}
          </span>
          {finePrint && <span className="ofr-meta" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>{finePrint}</span>}
        </span>
      )}
      <span className="ofr-go">{opensLabel || (isGift ? 'Buy this card' : 'Lock it in')}</span>
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

function InfoBlocks({ blocks }) {
  if (!blocks?.length) return null
  return (
    <section style={{ padding: '56px 32px', borderTop: '1px solid var(--ofr-line)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
      {blocks.map((b) => (
        <div key={b.title} style={{ border: '1px solid var(--ofr-line)', padding: '26px 24px' }}>
          <h3 className="ofr-display" style={{ fontSize: 20, lineHeight: 1.05, marginBottom: 14 }}>{b.title}</h3>
          <ul className="ofr-includes" style={{ padding: 0, margin: 0 }}>
            {b.lines.map((line) => <li key={line} style={{ fontSize: 14, padding: '10px 0' }}>{line}</li>)}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** A pre-BLACKFRIDAY /offers/<slug> link: Stillorgan's row with that slug, or 404. */
async function redirectLegacySlug(db, slug, purchase) {
  const stillorgan = await resolveOfferStudio(db, 'stillorgan')
  if (!stillorgan) notFound()
  const { data, error } = await db
    .from('sale_offers')
    .select('slug')
    .eq('location_id', stillorgan.location.id)
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  if (!data) notFound()
  redirect(legacyOfferRedirect(data.slug, purchase))
}

export default async function OfferStudioPage(props) {
  const { studio: key } = await props.params
  const sp = await props.searchParams
  const db = createServerClient()

  if (!studioForKey(key)) {
    await redirectLegacySlug(db, key, typeof sp?.purchase === 'string' ? sp.purchase : null)
  }
  const resolved = await resolveOfferStudio(db, key)
  if (!resolved) notFound()
  const { studio, location } = resolved

  const { data, error } = await db
    .from('sale_offers')
    .select('*')
    .eq('active', true)
    .eq('location_id', location.id)
    .order('sort', { ascending: true })
  if (error) throw error

  const now = new Date()
  const zone = await displayZoneFor(db, null, location.id, 'offers')
  const copy = offersPageCopy(location)
  const offers = storefrontOffers(data, now)
  const hero = heroFor(offers, copy, studio.label)
  // Decisions in src/lib/offers-storefront.js (tested there).
  const countdown = storefrontCountdown(offers, now)
  const flagFor = (o) => (isCyberMondayOnly(o, offers) ? 'Cyber Monday only' : flagForSlug(o.slug))
  const opensLabelFor = (o) => (offerIsUpcoming(o, now)
    ? `Opens ${formatSaleDeadline(o.starts_at, { uppercase: false, zone })}`
    : null)

  const sections = CATEGORY_ORDER
    .map((cat) => ({ key: cat, meta: CATEGORY_META[cat], items: offers.filter((o) => o.category === cat) }))
    .filter((s) => s.items.length > 0)

  return (
    <main>
      <div className="ofr-strip" aria-hidden="true">
        <span>{hero.marquee.repeat(4)}</span>
      </div>

      <header style={{ padding: '72px 32px 56px', borderBottom: '1px solid var(--ofr-line)' }}>
        <p style={{ fontSize: 11, letterSpacing: '.3em', textTransform: 'uppercase', color: '#777', marginBottom: 30 }}>
          <Link href="/offers" style={{ color: 'inherit', textDecoration: 'none' }}>← All studios</Link>
        </p>
        <p className="ofr-display" style={{ fontSize: 15, letterSpacing: '.55em', marginBottom: 52 }}>{studio.label.toUpperCase()}</p>
        <h1 className="ofr-display" style={{ fontSize: 'clamp(52px,9vw,104px)', lineHeight: .92, letterSpacing: '-.01em' }}>
          {hero.line1}<br /><span className="ofr-outline">{hero.line2}</span>
        </h1>
        <p style={{ marginTop: 26, maxWidth: '52ch', color: '#b5b5b5', fontSize: 16, lineHeight: 1.6 }}>
          {hero.blurb}
        </p>
        {countdown && (
          <div className="ofr-deadline">
            <b>{countdown.label}</b>
            <SaleCountdown endsAt={countdown.at} doneLabel={countdown.doneLabel} />
          </div>
        )}
      </header>

      {sections.length === 0 ? (
        <div style={{ padding: '80px 32px', textAlign: 'center' }}>
          <p className="ofr-display" style={{ fontSize: 32 }}>Nothing on sale right now</p>
          <p style={{ color: '#9a9a9a', marginTop: 12 }}>Keep an eye on your inbox — we&rsquo;ll let you know when the next one opens.</p>
        </div>
      ) : (
        sections.map((s, i) => (
          <div key={s.key}>
            <SectionHead idx={String(i + 1).padStart(2, '0')} title={s.meta.title} tag={s.meta.tag} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
              {s.items.map((o) => (
                <OfferCard key={o.id} offer={o} studio={studio} flag={flagFor(o)} opensLabel={opensLabelFor(o)} />
              ))}
            </div>
          </div>
        ))
      )}

      <InfoBlocks blocks={copy.infoBlocks} />
    </main>
  )
}
