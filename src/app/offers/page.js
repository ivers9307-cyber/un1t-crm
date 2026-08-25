// /offers — the public storefront (OFFERS.7, generalised in GIFTCARD.1).
//
// Originally the weekend "lock in" sale landing. It is now driven by the
// CATEGORY of whatever is active in sale_offers, because the same rail sells
// two very different things:
//   * a TIMED SALE (membership / class_pack) — bonus headline, was-price,
//     countdown, urgency copy;
//   * an EVERGREEN product (gift_card) — no deadline, no bonus, no discount.
// Rendering sale urgency over a gift card would be a lie, so the hero, the
// marquee and the card body all branch on category rather than being edited
// by hand each time the storefront changes.
import Link from 'next/link'
import { createServerClient } from '@/lib/supabase'
import { offerIsOpen, offerHasDeadline, formatEuro } from '@/lib/sale-offers'
import SaleCountdown from '@/components/offers/SaleCountdown'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CATEGORY_META = {
  gift_card:  { title: 'Gift Cards',  tag: 'Valid 5 years · redeem against anything' },
  membership: { title: 'Memberships', tag: 'Paid upfront' },
  class_pack: { title: 'Class Packs', tag: 'Stock up · train on your schedule' },
}
// Display order. A category with no active rows renders nothing at all.
const CATEGORY_ORDER = ['gift_card', 'membership', 'class_pack']

// The big numeral at the top of a card. For a gift card the VALUE is the
// headline — there is no term to state.
function termFor(offer) {
  if (offer.category === 'gift_card') {
    return { num: formatEuro(offer.price_cents), label: 'GIFT CARD' }
  }
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
  const isGift = offer.category === 'gift_card'
  const flag = FLAGS[offer.slug]
  // The €100-off was-price belongs to the August sale only. A gift card is
  // sold at face value and must never show a struck-through price.
  const was = offer.category === 'membership' ? offer.price_cents + 10000 : null
  return (
    <Link
      href={`/offers/${offer.slug}`}
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
          {was && <span className="ofr-was">{formatEuro(was)}</span>}
        </span>
      )}
      <span className="ofr-go">{isGift ? 'Buy this card' : 'Lock it in'}</span>
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

// Hero + marquee follow the storefront, not the calendar: a gift-card-only
// storefront gets gift copy and NO countdown.
function heroFor(offers) {
  const giftOnly = offers.length > 0 && offers.every((o) => o.category === 'gift_card')
  if (giftOnly) {
    return {
      marquee: 'UN1T GIFT CARDS · TRAINING THEY WILL ACTUALLY USE · ',
      line1: 'GIVE THE GIFT',
      line2: 'OF TRAINING',
      blurb: 'A UN1T gift card is coached strength and conditioning, 45 minutes at a time. Pick a value, pay in two minutes, and we will send you everything you need to hand it over.',
    }
  }
  return {
    marquee: 'LOCK IN YOUR MEMBERSHIP · ',
    line1: 'LOCK IN YOUR',
    line2: 'MEMBERSHIP',
    blurb: 'Every plan comes with extra time or extra classes on the house. Pay once, train more, done.',
  }
}

export default async function OffersPage() {
  const db = createServerClient()
  const { data } = await db
    .from('sale_offers')
    .select('*')
    .eq('active', true)
    .order('sort', { ascending: true })

  const offers = (data || []).filter((o) => offerIsOpen(o))
  const hero = heroFor(offers)
  // Only a genuinely dated offer drives a countdown. Gift cards have
  // ends_at NULL and must not render one.
  const dated = offers.filter(offerHasDeadline)
  const endsAt = dated.length ? dated[0].ends_at : null

  const sections = CATEGORY_ORDER
    .map((key) => ({ key, meta: CATEGORY_META[key], items: offers.filter((o) => o.category === key) }))
    .filter((s) => s.items.length > 0)

  return (
    <main>
      <div className="ofr-strip" aria-hidden="true">
        <span>{hero.marquee.repeat(4)}</span>
      </div>

      <header style={{ padding: '72px 32px 56px', borderBottom: '1px solid var(--ofr-line)' }}>
        <p className="ofr-display" style={{ fontSize: 15, letterSpacing: '.55em', marginBottom: 52 }}>UN1T STILLORGAN</p>
        <h1 className="ofr-display" style={{ fontSize: 'clamp(52px,9vw,104px)', lineHeight: .92, letterSpacing: '-.01em' }}>
          {hero.line1}<br /><span className="ofr-outline">{hero.line2}</span>
        </h1>
        <p style={{ marginTop: 26, maxWidth: '52ch', color: '#b5b5b5', fontSize: 16, lineHeight: 1.6 }}>
          {hero.blurb}
        </p>
        {endsAt && (
          <div className="ofr-deadline">
            <b>Sale ends</b>
            <SaleCountdown endsAt={endsAt} />
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
              {s.items.map((o) => <OfferCard key={o.id} offer={o} />)}
            </div>
          </div>
        ))
      )}
    </main>
  )
}
