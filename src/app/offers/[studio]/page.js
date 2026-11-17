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
import { heroFor, CATEGORY_ORDER, storefrontOffers, storefrontCountdown, isCyberMondayOnly, termForSlug, flagForSlug, offerFinePrint, offerValueLine, offerTermLine, splitMonthStrip } from '@/lib/offers-storefront'
import { legacyOfferRedirect } from '@/lib/offers-legacy-redirect'
import { displayZoneFor } from '@/lib/display-zone'
import SaleCountdown from '@/components/offers/SaleCountdown'
import OfferMarquee from '@/components/offers/OfferMarquee'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// `anchor` is the section id an audience link jumps to (AUDIENCE_TARGETS).
const CATEGORY_META = {
  gift_card:  { title: 'Gift Cards',  tag: 'Give the gift of training', anchor: 'gifts' },
  membership: { title: 'Memberships', tag: 'Bonus time on the house', anchor: 'memberships' },
  class_pack: { title: 'Class Packs', tag: 'Stock up · train on your schedule', anchor: 'packs' },
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
  // OFFERSDESIGN.1 — a sale card leads with the free extra, states what it
  // is on, and what the deal works out at. A flagged card (the biggest
  // bonus) is green before any hover, so a phone sees it too.
  const termLine = isGift ? null : offerTermLine(offer)
  const valueLine = isGift ? null : offerValueLine(offer)
  const best = !isGift && Boolean(flagForSlug(offer.slug))
  // OFFERSPOLISH.1 — the whole card is one link, so its name was every word
  // on it. The name is the headline, the term, the price and the action
  // (all visible text, in reading order); the prose is the description.
  const id = (part) => `ofr-${offer.id}-${part}`
  const nameIds = (isGift
    ? [id('term'), id('go')]
    : [id('bonus'), termLine && id('on'), id('price'), id('go')]).filter(Boolean).join(' ')
  const descIds = [flag && id('flag'), valueLine && id('value'), id('desc'), !isGift && finePrint && id('fine')].filter(Boolean).join(' ')
  return (
    <Link
      href={`/offers/${studio.key}/${offer.slug}`}
      className={best ? 'ofr-card ofr-card-best' : 'ofr-card'}
      aria-labelledby={nameIds}
      aria-describedby={descIds}
      style={{ minHeight: isGift ? 340 : 380, borderRight: '1px solid var(--ofr-line-soft)' }}
    >
      {flag && <span id={id('flag')} className="ofr-flag">{flag}</span>}
      {isGift ? (
        <span id={id('term')} className="ofr-display" style={{ fontSize: 'clamp(44px,5vw,64px)', lineHeight: .9 }}>
          {term.num}
          <small style={{ display: 'block', fontSize: 15, letterSpacing: '.3em', marginTop: 8 }}>{term.label}</small>
        </span>
      ) : (
        <span>
          <span id={id('bonus')} className="ofr-display ofr-bonus">{offer.bonus_headline || term.label}</span>
          {termLine && <span id={id('on')} className="ofr-display ofr-on">{termLine}</span>}
        </span>
      )}
      {isGift && <p id={id('desc')} className="ofr-meta">{offer.description}</p>}
      {!isGift && (
        <span style={{ marginTop: 'auto' }}>
          <span id={id('price')} className="ofr-display ofr-price">{formatEuro(offer.price_cents)}</span>
          {valueLine && <span id={id('value')} className="ofr-value">{valueLine}</span>}
          <span id={id('desc')} className="ofr-meta" style={{ display: 'block', marginTop: 10 }}>{offer.description}</span>
          {finePrint && <span id={id('fine')} className="ofr-meta" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>{finePrint}</span>}
        </span>
      )}
      <span id={id('go')} className="ofr-go">{opensLabel || (isGift ? 'Buy this card' : 'Lock it in')}</span>
    </Link>
  )
}

/**
 * OFFERSDESIGN.1 — a one-month membership as a full-width strip under the
 * card grid (a fourth card used to sit alone on a second row). Its words are
 * the offer row's own: name, bonus, price.
 */
function OfferStrip({ offer, studio, opensLabel }) {
  const id = (part) => `ofr-${offer.id}-${part}`
  // OFFERSTRIPFINE.1 — the strip shows the offer's fine print under its name
  // (e.g. a minimum commitment), as the cards do.
  const finePrint = offerFinePrint(offer)
  return (
    <Link
      href={`/offers/${studio.key}/${offer.slug}`}
      className="ofr-strip-offer"
      aria-labelledby={`${id('name')} ${id('price')} ${id('go')}`}
      aria-describedby={[id('bonus'), finePrint && id('fine')].filter(Boolean).join(' ')}
    >
      <span>
        <span id={id('name')} className="ofr-display ofr-strip-name">{offer.name}</span>
        {finePrint && <span id={id('fine')} className="ofr-meta" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>{finePrint}</span>}
      </span>
      <span className="ofr-strip-meta">
        <span id={id('bonus')}>{offer.bonus_headline}</span>
        <span aria-hidden="true"> · </span>
        <span id={id('price')}>{formatEuro(offer.price_cents)}</span>
      </span>
      <span id={id('go')} className="ofr-go">{opensLabel || 'Lock it in'}</span>
    </Link>
  )
}

function SectionHead({ idx, title, tag, id }) {
  return (
    <div id={id} style={{ padding: '40px 32px 24px', scrollMarginTop: 16, borderBottom: '1px solid var(--ofr-line)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '10px 24px' }}>
      <span className="ofr-display" style={{ fontSize: 14, letterSpacing: '.3em', color: '#666', transform: 'translateY(-1.6em)' }}>{idx}</span>
      <h2 className="ofr-display" style={{ fontSize: 'clamp(32px,4.4vw,56px)', lineHeight: .95, letterSpacing: '-.01em' }}>{title}</h2>
      <span style={{ fontSize: 12, color: '#8a8a8a', letterSpacing: '.18em', textTransform: 'uppercase', marginLeft: 'auto' }}>{tag}</span>
    </div>
  )
}

function InfoBlocks({ blocks }) {
  if (!blocks?.length) return null
  return (
    <section id="members" style={{ scrollMarginTop: 16, padding: '56px 32px', borderTop: '1px solid var(--ofr-line)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
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

/** "MONDAY 30 NOVEMBER, 23:59" → "MON 30 NOV"; '' stays ''. */
function shortSaleDate(long) {
  const [weekday = '', day = '', month = ''] = long.split(',')[0].split(' ')
  return weekday ? `${weekday.slice(0, 3)} ${day} ${month.slice(0, 3)}`.trim() : ''
}

/** OFFERSDESIGN.1 — the operator's questions and answers; nothing when there are none. */
function Faq({ items }) {
  if (!items?.length) return null
  return (
    <section id="faq" style={{ padding: '40px 32px 56px', borderTop: '1px solid var(--ofr-line)', scrollMarginTop: 16 }}>
      <h2 className="ofr-display" style={{ fontSize: 'clamp(28px,3.6vw,44px)', margin: '0 0 12px' }}>Good to know</h2>
      <div className="ofr-faq">
        {items.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

/** The "who are you" row: links to sections that exist on this page only. */
function AudienceRow({ links, present }) {
  const shown = (links || []).filter((l) => present.has(l.target))
  if (shown.length === 0) return null
  return (
    <nav className="ofr-who ofr-bleed" aria-label="Find your offer">
      {shown.map((l) => (
        <a key={`${l.title}-${l.target}`} href={`#${l.target}`}>
          <span className="ofr-display">{l.title}</span>
          {l.hint && <small>{l.hint} →</small>}
        </a>
      ))}
    </nav>
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
  // "MON 30 NOV": the studio-clock date, short enough for one line on a phone.
  const calmLabel = countdown?.label === 'Sale ends'
    ? shortSaleDate(formatSaleDeadline(countdown.at, { zone }))
    : null
  const flagFor = (o) => (isCyberMondayOnly(o, offers) ? 'Cyber Monday only' : flagForSlug(o.slug))
  const opensLabelFor = (o) => (offerIsUpcoming(o, now)
    ? `Opens ${formatSaleDeadline(o.starts_at, { uppercase: false, zone })}`
    : null)

  const sections = CATEGORY_ORDER
    .map((cat) => ({ key: cat, meta: CATEGORY_META[cat], items: offers.filter((o) => o.category === cat) }))
    .filter((s) => s.items.length > 0)
  // Sections an audience link may land on.
  const present = new Set([
    ...sections.map((s) => s.meta.anchor),
    ...(copy.infoBlocks?.length ? ['members'] : []),
    ...(copy.faq?.length ? ['faq'] : []),
  ])

  return (
    <main>
      <div className="ofr-bleed">
        <OfferMarquee text={hero.marquee.repeat(4)} />
      </div>

      {/* OFFERSDESIGN.1 — full-bleed hero, the operator's photo behind the
          headline (settings.offers_page.heroImage); none set, no photo. */}
      <header className={copy.heroImage ? 'ofr-hero ofr-bleed ofr-hero-photo' : 'ofr-hero ofr-bleed'}>
        {copy.heroImage && (
          <img src={copy.heroImage} alt="" fetchPriority="high" decoding="async" />
        )}
        <div className="ofr-hero-inner">
          <p style={{ fontSize: 11, letterSpacing: '.3em', textTransform: 'uppercase', color: '#9a9a9a', margin: '0 0 14px' }}>
            <Link href="/offers" style={{ color: 'inherit', textDecoration: 'none' }}>← All studios</Link>
          </p>
          <p className="ofr-display" style={{ fontSize: 13, letterSpacing: '.5em', margin: '0 0 18px' }}>{studio.label.toUpperCase()}</p>
          <h1 className="ofr-display" style={{ fontSize: 'clamp(44px,5.6vw,88px)', lineHeight: .9, letterSpacing: '-.01em', margin: 0 }}>
            {hero.line1}<br /><span className="ofr-outline">{hero.line2}</span>
          </h1>
          <p style={{ margin: '16px 0 20px', maxWidth: '46ch', color: '#d4d4d4', fontSize: 'clamp(15px,1.3vw,18px)', lineHeight: 1.6 }}>
            {hero.blurb}
          </p>
          {(countdown || copy.proofLine) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              {countdown && (
                <div className="ofr-deadline" style={{ marginTop: 0 }}>
                  <b>{countdown.label}</b>
                  <SaleCountdown endsAt={countdown.at} doneLabel={countdown.doneLabel} calmLabel={calmLabel} />
                </div>
              )}
              {copy.proofLine && <p className="ofr-proof">{copy.proofLine}</p>}
            </div>
          )}
        </div>
      </header>

      <AudienceRow links={copy.audienceLinks} present={present} />

      {sections.length === 0 ? (
        <div style={{ padding: '80px 32px', textAlign: 'center' }}>
          <p className="ofr-display" style={{ fontSize: 32 }}>Nothing on sale right now</p>
          <p style={{ color: '#9a9a9a', marginTop: 12 }}>Keep an eye on your inbox — we&rsquo;ll let you know when the next one opens.</p>
        </div>
      ) : (
        sections.map((s, i) => {
          const { grid, strip } = splitMonthStrip(s.items)
          return (
            <div key={s.key}>
              <SectionHead id={s.meta.anchor} idx={String(i + 1).padStart(2, '0')} title={s.meta.title} tag={s.meta.tag} />
              {grid.length > 0 && (
                <div className="ofr-grid" style={{ '--ofr-cols': Math.min(3, grid.length) }}>
                  {grid.map((o) => (
                    <OfferCard key={o.id} offer={o} studio={studio} flag={flagFor(o)} opensLabel={opensLabelFor(o)} />
                  ))}
                </div>
              )}
              {strip.map((o) => (
                <OfferStrip key={o.id} offer={o} studio={studio} opensLabel={opensLabelFor(o)} />
              ))}
            </div>
          )
        })
      )}

      <InfoBlocks blocks={copy.infoBlocks} />
      <Faq items={copy.faq} />
    </main>
  )
}
