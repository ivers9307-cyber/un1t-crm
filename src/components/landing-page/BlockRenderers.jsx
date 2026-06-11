// Block renderers for the public /welcome pages.
//
// Pure presentational components — no hooks, no client state — so
// they can be rendered from either a server component (the live
// public page) or a client component (the in-iframe edit overlay).
// Interactivity ships as imported client islands (BookingWidget,
// WaitlistWidget, VideoTestimonials, CountUp).
//
// SOURCE OF TRUTH for "what does each block type look like".
// Adding a new block type means: register it in
// src/lib/landing-page-blocks.js, add a case here, add an edit
// panel in LandingPageSettingsForm.jsx.
//
// WEBSITE-REDESIGN 2026-06 — "industrial athletic editorial":
// Anton display type (font-display) + Poppins body (font-body, set by
// src/app/welcome/layout.js), monochrome black/white, film-grain +
// outlined-watermark texture, scroll reveals (.lp-reveal, armed only
// on the public pages — see RevealManager). Every block keeps its
// exact data shape and EditableText/EditableImage field paths, so the
// operator's saved content and the CRM editor are untouched.

import Link from 'next/link'
import { filterVisibleReviews, marqueeDurationSeconds } from '@/lib/google-business/reviews'
import BookingWidget from '@/components/BookingWidget'
import RaceSignupWidget from '@/components/RaceSignupWidget'
import WaitlistWidget from '@/components/WaitlistWidget'
import VideoTestimonials from './VideoTestimonials'
import CountUp from './CountUp'
import { parseEmbed } from '@/lib/landing-page-embed'
import EditableText from './EditableText'
import EditableImage from './EditableImage'
import HeroMediaTools from './HeroMediaTools'
import LogoSwapper from './LogoSwapper'

// Pass-through wrapper used by every block renderer. When `onEdit`
// is provided (i.e. we're rendering inside the iframe edit
// overlay), the text becomes contentEditable and edits propagate
// via onEdit(path, newValue). When `onEdit` is absent (public page
// render), it's a plain text fragment — zero overhead.
function E({ value, onEdit, path, multiline }) {
  if (!onEdit) return <>{value}</>
  return (
    <EditableText
      value={value || ''}
      onChange={(v) => onEdit(path, v)}
      multiline={multiline}
    />
  )
}

// Shared section header: hairline + uppercase tracked label. The label
// is presentational chrome (not operator data) so it stays consistent
// across every page.
function Eyebrow({ children, dark = true }) {
  return (
    <div className="lp-reveal flex items-center gap-4 mb-10 md:mb-14">
      <span className={`h-px w-10 ${dark ? 'bg-white/30' : 'bg-black/25'}`} aria-hidden="true" />
      <span className={`text-[11px] uppercase tracking-[0.35em] font-semibold ${dark ? 'text-white/55' : 'text-black/45'}`}>
        {children}
      </span>
    </div>
  )
}

export default function BlockRenderer({ block, onEdit, locationId, publicPath, reviewsData, ctaHref, ctaLabel }) {
  // onEdit is bound to this block: caller hands us a generic
  // (blockId, path, value) function and we curry the blockId so
  // each child renderer thinks in local field paths.
  const localOnEdit = onEdit
    ? (path, value) => onEdit(block.id, path, value)
    : null
  // Common props bundled so we don't repeat ourselves on every
  // block case. locationId is needed by EditableImage to attribute
  // the upload to the right tenant.
  const editProps = { onEdit: localOnEdit, locationId }
  switch (block.type) {
    case 'hero':        return <HeroBlock        block={block} {...editProps} ctaHref={ctaHref} ctaLabel={ctaLabel} />
    case 'booking':     return <BookingBlock     block={block} />
    case 'pillars':     return <PillarsBlock     block={block} {...editProps} />
    case 'gallery':     return <GalleryBlock     block={block} {...editProps} />
    case 'event':       return <EventBlock       block={block} />
    case 'lead_form':   return <LeadFormBlock    block={block} onEdit={localOnEdit} publicPath={publicPath} />
    case 'embed':       return <EmbedBlock       block={block} onEdit={localOnEdit} />
    case 'stats':       return <StatsBlock       block={block} onEdit={localOnEdit} />
    case 'testimonial': return <TestimonialBlock block={block} onEdit={localOnEdit} />
    case 'reviews':     return <ReviewsBlock     block={block} onEdit={localOnEdit} reviewsData={reviewsData} />
    case 'video_testimonials': return <VideoTestimonialsBlock block={block} onEdit={localOnEdit} />
    default:            return null
  }
}

// Brand words for the hero's marquee strip. Presentational chrome —
// the brand voice, not operator data.
const MARQUEE_WORDS = [
  'We train as one',
  'Strength & conditioning',
  'Coach-led',
  'Built for racing',
  'Community',
]

function HeroMarquee() {
  // Track duplicated once so the -50% translate loops seamlessly
  // (same trick as the reviews marquee).
  const items = [...MARQUEE_WORDS, ...MARQUEE_WORDS]
  return (
    <div className="relative border-t border-white/10 py-4 overflow-hidden" aria-hidden="true">
      <div className="lp-marquee-track">
        {items.map((w, i) => (
          <span
            key={i}
            className="font-display uppercase text-sm md:text-base tracking-[0.25em] text-white/35 whitespace-nowrap flex items-center"
          >
            <span className="px-6">{w}</span>
            <span className="text-white/20">✦</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// Hero — full-viewport opener. Backdrop precedence: video > image >
// outlined-watermark fallback. Media gets a slow Ken Burns push-in
// (image only), film grain, and a bottom-weighted scrim so the type
// always carries. Content staggers in on load (CSS only). The primary
// CTA is passed down from the page (computed from the page's own
// funnel blocks) — the hero never invents a target.
export function HeroBlock({ block, onEdit, locationId, ctaHref, ctaLabel }) {
  const href = ctaHref || (onEdit ? '#book' : null)
  const label = ctaLabel || 'Book a free consult'
  return (
    <section className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
      {block.video_url ? (
        <>
          <video
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            src={block.video_url}
            poster={block.image_url || undefined}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0.88) 100%)',
            }}
            aria-hidden="true"
          />
        </>
      ) : block.image_url ? (
        <>
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
            <div
              className="absolute inset-0 bg-cover bg-center lp-kenburns"
              style={{ backgroundImage: `url(${block.image_url})` }}
            />
          </div>
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0.88) 100%)',
            }}
            aria-hidden="true"
          />
        </>
      ) : (
        // No media: oversized outlined wordmark + soft radial glow.
        // Strong, brand-true, zero assets — never a dead black screen.
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          <div
            className="absolute inset-0 opacity-80"
            style={{
              background:
                'radial-gradient(ellipse 75% 55% at 50% 38%, rgba(255,255,255,0.10) 0%, rgba(0,0,0,0) 65%)',
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
            <span className="lp-outline font-display leading-none select-none text-[42vw] md:text-[34vw]">
              UN1T
            </span>
          </div>
        </div>
      )}

      {/* Hero media tools — only when in edit mode. Sit top-right
          inside the hero so they're visible without overlapping the
          headline. Uses the same /media upload route as everything
          else. */}
      {onEdit && (
        <HeroMediaTools
          imageUrl={block.image_url}
          videoUrl={block.video_url}
          locationId={locationId}
          onChangeImage={(url) => onEdit(['image_url'], url)}
          onChangeVideo={(url) => onEdit(['video_url'], url)}
        />
      )}

      <div className="relative z-10 flex-1 flex items-center justify-center px-6 pt-28 pb-16 md:pt-32">
        <div className="lp-hero-stagger max-w-6xl mx-auto text-center">
          {(block.eyebrow || onEdit) && (
            <p className="text-[11px] md:text-xs uppercase tracking-[0.45em] text-white/60 mb-6 font-semibold">
              <E value={block.eyebrow} onEdit={onEdit} path={['eyebrow']} />
            </p>
          )}
          {(block.headline || block.subhead || onEdit) && (
            <h1 className="font-display uppercase text-[clamp(2.9rem,9vw,7.5rem)] leading-[0.95] tracking-tight text-white">
              <E value={block.headline} onEdit={onEdit} path={['headline']} />
              {(block.subhead || onEdit) && (
                <span className="block mt-3 text-[clamp(1.2rem,3vw,2.4rem)] leading-[1.1] text-white/65">
                  <E value={block.subhead} onEdit={onEdit} path={['subhead']} />
                </span>
              )}
            </h1>
          )}
          {(block.subtext || onEdit) && (
            <p className="mt-7 text-base md:text-lg text-white/75 max-w-2xl mx-auto leading-relaxed">
              <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
            </p>
          )}
          {href && (
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <a href={href} className="lp-btn">
                {label}
                <span className="lp-btn-arrow" aria-hidden="true">→</span>
              </a>
            </div>
          )}
          {/* Scroll cue — decorative, fades under reduced motion. */}
          <div className="mt-12 flex justify-center" aria-hidden="true">
            <svg className="lp-cue w-5 h-5 text-white/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </div>

      <div className="relative z-10">
        <HeroMarquee />
      </div>
    </section>
  )
}

export function BookingBlock({ block }) {
  return (
    <section id="book" className="scroll-mt-20 bg-black pt-20 pb-24 md:pt-28 md:pb-32">
      <div className="max-w-6xl mx-auto px-6">
        <Eyebrow>Your first step</Eyebrow>
        <div className="lp-reveal text-center mb-4">
          <h2 className="font-display uppercase text-4xl md:text-6xl tracking-tight text-white">
            Start here
          </h2>
        </div>
        {/* Trust row — generic on purpose: the widget itself names the
            session being booked, so these stay true for any slug. */}
        <ul className="lp-reveal lp-d1 flex flex-wrap justify-center gap-x-8 gap-y-2 mb-12 text-sm text-white/60">
          {['Takes under a minute', 'No commitment', 'All levels welcome'].map((t) => (
            <li key={t} className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              {t}
            </li>
          ))}
        </ul>
        <div className="lp-reveal lp-d2 flex justify-center">
          {block.slug ? (
            <div className="rounded-2xl ring-1 ring-white/15 shadow-[0_40px_120px_-40px_rgba(255,255,255,0.18)]">
              <BookingWidget slug={block.slug} />
            </div>
          ) : (
            <p className="text-white/50 text-sm">Booking form not configured.</p>
          )}
        </div>
        <p className="lp-reveal lp-d3 text-center text-xs text-white/45 mt-8">
          Prefer to talk to a human first? Just walk in — we&apos;d love to show you around.
        </p>
      </div>
    </section>
  )
}

export function EventBlock({ block }) {
  // Inline event signup — the full RaceSignupWidget for a chosen event,
  // rendered into the page. block.slug picks the event; unset shows a
  // gentle placeholder so the public page never has a broken section.
  return (
    <section id={`event-${block.slug || 'signup'}`} className="scroll-mt-20 bg-black pt-20 pb-24 md:pt-28 md:pb-32 border-t border-white/10">
      <div className="max-w-3xl mx-auto px-6">
        {block.title && (
          <h2 className="lp-reveal font-display uppercase text-3xl md:text-5xl tracking-tight text-white text-center mb-10">
            {block.title}
          </h2>
        )}
        <div className="lp-reveal lp-d1 flex justify-center">
          {block.slug ? (
            <div className="rounded-2xl ring-1 ring-white/15">
              <RaceSignupWidget slug={block.slug} />
            </div>
          ) : (
            <p className="text-white/50 text-sm">Event signup not configured.</p>
          )}
        </div>
      </div>
    </section>
  )
}

export function LeadFormBlock({ block, onEdit, publicPath }) {
  return (
    <section id="waitlist" className="scroll-mt-20 relative bg-black text-white py-24 md:py-32 border-t border-white/10 overflow-hidden">
      {/* Faint outlined watermark drifting behind the form — depth
          without noise. */}
      <div className="absolute inset-y-0 -right-10 hidden lg:flex items-center pointer-events-none" aria-hidden="true">
        <span className="lp-outline font-display leading-none text-[18rem]">UN1T</span>
      </div>
      <div className="relative max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
        <div>
          <Eyebrow>Join us</Eyebrow>
          {(block.heading || onEdit) && (
            <h2 className="lp-reveal font-display uppercase text-4xl md:text-6xl leading-[0.98] tracking-tight mb-5">
              <E value={block.heading} onEdit={onEdit} path={['heading']} />
            </h2>
          )}
          {(block.subtext || onEdit) && (
            <p className="lp-reveal lp-d1 text-white/70 leading-relaxed max-w-md text-base md:text-lg">
              <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
            </p>
          )}
        </div>
        <div className="lp-reveal lp-d2">
          <div className="lp-card-glow rounded-2xl p-6 md:p-8">
            <WaitlistWidget
              publicPath={publicPath}
              buttonLabel={block.button_label}
              successMessage={block.success_message}
              consentLabel={block.consent_label}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

export function PillarsBlock({ block, onEdit, locationId }) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 3) : []
  if (items.length === 0 && !onEdit) return null
  return (
    <section className="bg-white text-black py-24 md:py-32">
      <div className="max-w-6xl mx-auto px-6">
        <Eyebrow dark={false}>Why UN1T</Eyebrow>
        <div className="grid md:grid-cols-3 gap-10 md:gap-8">
          {items.map((p, i) => (
            <Pillar
              key={i}
              number={p.number || ''}
              title={p.title || ''}
              body={p.body || ''}
              photoUrl={p.photo_url || null}
              onEdit={onEdit}
              locationId={locationId}
              itemIndex={i}
              delayClass={i === 1 ? 'lp-d1' : i === 2 ? 'lp-d2' : ''}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

export function GalleryBlock({ block, onEdit, locationId }) {
  const items = Array.isArray(block.items) ? block.items : []
  if (items.length === 0 && !onEdit) return null
  return (
    <section className="bg-black py-24 md:py-32 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        {(block.title || onEdit) && (
          <div className="lp-reveal flex items-center gap-4 mb-10 md:mb-14">
            <span className="h-px w-10 bg-white/30" aria-hidden="true" />
            <p className="text-[11px] uppercase tracking-[0.35em] font-semibold text-white/55">
              <E value={block.title} onEdit={onEdit} path={['title']} />
            </p>
          </div>
        )}
        <div className="lp-reveal lp-d1 lp-mosaic grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
          {items.map((g, i) => (
            <figure key={i} className="relative aspect-square overflow-hidden bg-white/5 group rounded-lg">
              {onEdit ? (
                <EditableImage
                  src={g.url}
                  alt={g.alt || ''}
                  kind="image"
                  locationId={locationId}
                  className="absolute inset-0"
                  onChange={(url) => {
                    // null = remove this item; otherwise swap.
                    if (url === null) {
                      const next = items.filter((_, j) => j !== i)
                      onEdit(['items'], next)
                    } else {
                      onEdit(['items', i, 'url'], url)
                    }
                  }}
                />
              ) : (

                <img
                  src={g.url}
                  alt={g.alt || ''}
                  className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.06]"
                  loading="lazy"
                />
              )}
              {g.caption && (
                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-3 text-xs text-white/90 z-20 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  {g.caption}
                </figcaption>
              )}
            </figure>
          ))}
          {onEdit && items.length < 24 && (
            // "Add photo" tile — sits at the end of the grid.
            // EditableImage with empty src renders the dashed
            // placeholder; on upload we append to items via the
            // setByPath route on the parent (path = ['items']
            // with the full new array).
            <figure className="relative aspect-square overflow-hidden bg-white/5 rounded-lg">
              <EditableImage
                src=""
                kind="image"
                locationId={locationId}
                className="absolute inset-0"
                emptyLabel="+ Add photo"
                onChange={(url) => {
                  if (!url) return
                  const next = [...items, { url, alt: '', caption: '' }]
                  onEdit(['items'], next)
                }}
              />
            </figure>
          )}
        </div>
      </div>
    </section>
  )
}

export function EmbedBlock({ block, onEdit }) {
  const embed = parseEmbed(block.url)
  // In edit mode, keep the block visible even when the URL hasn't
  // been pasted yet (or is invalid) so the operator can still edit
  // the title / caption from the iframe and isn't fighting an
  // invisible section.
  if (!embed && !onEdit) return null
  return (
    <section className="bg-black py-24 md:py-32 border-t border-white/10">
      <div className="max-w-4xl mx-auto px-6">
        {(block.title || onEdit) && (
          <div className="lp-reveal flex items-center gap-4 mb-10">
            <span className="h-px w-10 bg-white/30" aria-hidden="true" />
            <p className="text-[11px] uppercase tracking-[0.35em] font-semibold text-white/55">
              <E value={block.title} onEdit={onEdit} path={['title']} />
            </p>
          </div>
        )}
        {/* 16:9 wrapper for YouTube; Instagram uses a taller portrait
            aspect for reels — we let IG decide its own height inside
            its own iframe. */}
        {embed && (
          <div
            className={
              embed.provider === 'instagram'
                ? 'lp-reveal lp-d1 relative w-full max-w-md mx-auto rounded-2xl overflow-hidden ring-1 ring-white/15'
                : 'lp-reveal lp-d1 relative w-full aspect-video bg-white/5 rounded-2xl overflow-hidden ring-1 ring-white/15'
            }
            style={embed.provider === 'instagram' ? { minHeight: '600px' } : undefined}
          >
            <iframe
              src={embed.embedUrl}
              title={block.title || 'Embedded video'}
              className="absolute inset-0 w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        )}
        {(block.caption || onEdit) && (
          <p className="lp-reveal lp-d2 text-center text-sm text-white/60 mt-5">
            <E value={block.caption} onEdit={onEdit} path={['caption']} />
          </p>
        )}
        {!embed && onEdit && (
          // Placeholder shown only in edit mode when no valid URL
          // is set — keeps the section interactive while the
          // operator pastes a YouTube / Instagram link in the form.
          <div className="aspect-video w-full bg-white/5 border border-dashed border-white/20 rounded-2xl flex items-center justify-center text-sm text-white/40 mt-2">
            Paste a YouTube or Instagram URL on the left to embed
          </div>
        )}
      </div>
    </section>
  )
}

export function StatsBlock({ block, onEdit }) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 3) : []
  if (items.length === 0 && !onEdit) return null
  return (
    <section className="bg-black text-white py-24 md:py-32 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid md:grid-cols-3 text-center md:divide-x md:divide-white/10">
          {items.map((s, i) => (
            <Stat
              key={i}
              number={s.number || ''}
              label={s.label || ''}
              onEdit={onEdit}
              itemIndex={i}
              delayClass={i === 1 ? 'lp-d1' : i === 2 ? 'lp-d2' : ''}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

export function TestimonialBlock({ block, onEdit }) {
  if (!block.quote && !block.author && !onEdit) return null
  // Long pasted reviews must read as editorial, not a wall — scale the
  // type down past ~280 chars. Pure function of the data, server-safe.
  const quoteLen = (block.quote || '').length
  const quoteCls = quoteLen > 280
    ? 'text-base md:text-lg leading-relaxed text-white/80'
    : 'text-2xl md:text-[2rem] leading-snug font-medium text-white/90'
  return (
    <section className="relative bg-black text-white py-24 md:py-32 border-t border-white/10 overflow-hidden">
      <div
        className="absolute top-10 left-1/2 -translate-x-1/2 font-display text-[14rem] leading-none text-white/[0.06] select-none pointer-events-none"
        aria-hidden="true"
      >
        &ldquo;
      </div>
      <div className="relative max-w-6xl mx-auto px-6">
        <blockquote className="lp-reveal max-w-3xl mx-auto text-center">
          <div className="text-amber-400 tracking-[0.3em] text-sm mb-8" aria-label="5 out of 5 stars">
            ★★★★★
          </div>
          {(block.quote || onEdit) && (
            <p className={quoteCls}>
              {onEdit
                ? <E value={block.quote} onEdit={onEdit} path={['quote']} multiline />
                : <>&ldquo;{block.quote}&rdquo;</>
              }
            </p>
          )}
          {(block.author || onEdit) && (
            <footer className="mt-8 flex items-center justify-center gap-4">
              <span className="h-px w-8 bg-white/25" aria-hidden="true" />
              <span className="text-xs uppercase tracking-[0.3em] text-white/60 font-semibold">
                <E value={block.author} onEdit={onEdit} path={['author']} />
              </span>
              <span className="h-px w-8 bg-white/25" aria-hidden="true" />
            </footer>
          )}
        </blockquote>
      </div>
    </section>
  )
}

// Reviews — continuous CSS marquee of Google reviews. Data is passed down
// from the page (reviewsData = { reviews, averageRating, totalCount }); the
// renderer does no fetching, so it stays pure + server-safe. Edit mode has no
// live reviewsData — show a placeholder so the operator sees where it lands.
export function ReviewsBlock({ block, onEdit, reviewsData }) {
  const minRating = Number.isFinite(block.min_rating) ? block.min_rating : 4
  const all = reviewsData?.reviews || []
  const visible = filterVisibleReviews(all, minRating)

  if (visible.length === 0) {
    if (!onEdit) return null
    return (
      <section className="bg-black text-white py-24 md:py-32 border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 text-center text-white/40 text-sm border border-dashed border-white/20 rounded py-10">
          Google reviews appear here on the live page (connect Google Business in
          Settings → Locations → Integrations, then sync).
        </div>
      </section>
    )
  }

  const duration = marqueeDurationSeconds(block.speed, visible.length)
  const track = [...visible, ...visible]

  return (
    <section className="bg-black text-white py-24 md:py-32 border-t border-white/10 overflow-hidden">
      <div className="max-w-6xl mx-auto px-6">
        {(block.title || block.show_aggregate) && (
          <div className="lp-reveal text-center mb-12">
            {block.title && (
              <h2 className="font-display uppercase text-3xl md:text-5xl tracking-tight">{block.title}</h2>
            )}
            {block.show_aggregate && reviewsData?.averageRating != null && (
              <div className="mt-5 flex items-baseline justify-center gap-3">
                <span className="font-display text-4xl md:text-5xl">
                  {Number(reviewsData.averageRating).toFixed(1)}
                </span>
                <span className="text-amber-400 tracking-[0.2em] text-sm">★★★★★</span>
                {reviewsData.totalCount != null && (
                  <span className="text-sm text-white/55">{reviewsData.totalCount} Google reviews</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="reviews-marquee-viewport relative lp-reveal lp-d1">
        <div
          className="reviews-marquee-track gap-4 px-2"
          style={{ animationDuration: `${duration}s` }}
        >
          {track.map((r, i) => (
            <ReviewCard key={`${r.id || r.google_review_id || i}-${i}`} review={r} />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-black to-transparent" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-black to-transparent" aria-hidden="true" />
      </div>
    </section>
  )
}

// Video testimonials — up to 3 portrait clips. The pure renderer draws
// the section + (editable) heading; the interactive poster→tap-to-play
// tiles live in the VideoTestimonials client island so first paint
// ships zero video bytes. Hidden on the public page when no clip has a
// video_url; in edit mode it stays visible with a hint so the operator
// can find the section + edit the heading.
export function VideoTestimonialsBlock({ block, onEdit }) {
  const clips = (Array.isArray(block.items) ? block.items : []).filter((it) => it && it.video_url).slice(0, 3)
  if (clips.length === 0 && !onEdit) return null
  return (
    <section className="bg-black text-white py-24 md:py-32 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        {(block.title || onEdit) && (
          <h2 className="lp-reveal font-display uppercase text-3xl md:text-5xl tracking-tight text-center mb-12">
            <E value={block.title} onEdit={onEdit} path={['title']} />
          </h2>
        )}
        {clips.length > 0 ? (
          <div className="lp-reveal lp-d1">
            <VideoTestimonials items={clips} />
          </div>
        ) : onEdit ? (
          <div className="max-w-md mx-auto text-center text-white/40 text-sm border border-dashed border-white/20 rounded py-10">
            Add up to 3 portrait videos in the &ldquo;Video testimonials&rdquo; panel on the left.
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ReviewCard({ review }) {
  const stars = '★★★★★'.slice(0, Math.max(0, Math.min(5, review.rating || 0)))
  return (
    <figure className="w-80 shrink-0 bg-white/[0.05] border border-white/10 rounded-2xl p-6 transition-colors hover:bg-white/[0.08]">
      <div className="text-amber-400 text-sm tracking-[0.18em]" aria-label={`${review.rating} out of 5`}>{stars}</div>
      <blockquote className="mt-4 text-sm leading-relaxed text-white/85 line-clamp-5">
        {review.comment}
      </blockquote>
      <figcaption className="mt-5 flex items-center gap-2.5 text-xs text-white/55">
        {review.author_photo_url ? (

          <img src={review.author_photo_url} alt="" className="w-7 h-7 rounded-full object-cover" loading="lazy" />
        ) : null}
        <span className="text-white/80 font-medium">{review.author_name || 'Google user'}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-white/40">
          <span className="text-[#4285F4] font-bold">G</span> Google
        </span>
      </figcaption>
    </figure>
  )
}

function Pillar({ number, title, body, photoUrl, onEdit, locationId, itemIndex, delayClass = '' }) {
  // Show the photo region if there IS a photo OR we're in edit mode
  // (so the operator has somewhere to drop one).
  const showPhotoRegion = !!photoUrl || !!onEdit
  return (
    <div className={`lp-reveal ${delayClass} group`}>
      {showPhotoRegion && (
        <div className="aspect-[3/4] overflow-hidden bg-black/5 relative rounded-xl">
          {onEdit ? (
            <EditableImage
              src={photoUrl || ''}
              kind="image"
              locationId={locationId}
              onChange={(url) => onEdit(['items', itemIndex, 'photo_url'], url)}
              emptyLabel="Add pillar photo"
              className="absolute inset-0"
            />
          ) : (

            <img
              src={photoUrl}
              alt=""
              className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.05]"
              loading="lazy"
            />
          )}
        </div>
      )}
      <div className="mt-6 flex items-baseline gap-4">
        <span className="font-display text-xl text-black/25 tracking-wide">
          <E value={number} onEdit={onEdit} path={['items', itemIndex, 'number']} />
        </span>
        <span className="h-px flex-1 bg-black/10" aria-hidden="true" />
      </div>
      <h3 className="mt-3 font-display uppercase text-[1.6rem] leading-tight tracking-wide">
        <E value={title} onEdit={onEdit} path={['items', itemIndex, 'title']} />
      </h3>
      <p className="mt-3 text-black/65 leading-relaxed">
        <E value={body} onEdit={onEdit} path={['items', itemIndex, 'body']} multiline />
      </p>
    </div>
  )
}

function Stat({ number, label, onEdit, itemIndex, delayClass = '' }) {
  return (
    <div className={`lp-reveal ${delayClass} px-6 py-8 md:py-4`}>
      <div className="font-display text-[clamp(3.5rem,7vw,5.5rem)] leading-none tracking-tight">
        {onEdit ? (
          <E value={number} onEdit={onEdit} path={['items', itemIndex, 'number']} />
        ) : (
          <CountUp value={number} />
        )}
      </div>
      <div className="mt-3 text-xs uppercase tracking-[0.3em] text-white/55 font-semibold">
        <E value={label} onEdit={onEdit} path={['items', itemIndex, 'label']} />
      </div>
    </div>
  )
}

// Site chrome — top nav (logo or wordmark) + footer. Same components
// in both public + edit-mode renders so the two never drift.
//
// Public pages pass `sticky` (fixed glass bar) + a CTA computed from
// the page's own funnel blocks, so the conversion action is visible at
// every scroll position. The edit-mode preview keeps the absolute
// header (no fixed bar fighting the editor's own toolbars) and its
// click-to-change logo affordance.
export function SiteHeader({
  logoUrl,
  logoAlt = 'UN1T Dublin',
  logoWidthPx = 200,
  onChangeLogo = null,
  locationId = null,
  sticky = false,
  ctaHref = null,
  ctaLabel = 'Book a free consult',
}) {
  return (
    <header
      className={
        sticky
          ? 'fixed inset-x-0 top-0 z-40 bg-black/55 backdrop-blur-md border-b border-white/10'
          : 'absolute inset-x-0 top-0 z-20'
      }
    >
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
        {onChangeLogo ? (
          <EditableLogo
            logoUrl={logoUrl}
            logoAlt={logoAlt}
            logoWidthPx={logoWidthPx}
            locationId={locationId}
            onChange={onChangeLogo}
          />
        ) : logoUrl ? (

          <img
            src={logoUrl}
            alt={logoAlt}
            style={{ width: `${Math.min(logoWidthPx, 170)}px`, height: 'auto' }}
            className="object-contain"
          />
        ) : (
          <div className="font-display text-2xl tracking-widest text-white">UN1T</div>
        )}
        {sticky && ctaHref && (
          <a href={ctaHref} className="lp-btn !px-5 !py-2.5 !text-sm shrink-0">
            {ctaLabel}
            <span className="lp-btn-arrow hidden sm:inline" aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </header>
  )
}

// EditableLogo — iframe-only affordance for swapping/removing the
// site logo. Lives here (in the same file as SiteHeader) because
// it's intimately tied to the logo's specific layout — width-driven
// sizing with auto height, object-contain (NOT object-cover so the
// logo isn't cropped).
function EditableLogo({ logoUrl, logoAlt, logoWidthPx, locationId, onChange }) {
  return (
    <LogoSwapper
      src={logoUrl}
      alt={logoAlt}
      widthPx={logoWidthPx}
      locationId={locationId}
      onChange={onChange}
    />
  )
}

export function SiteFooter({ ctaHref = '#book', ctaLabel = 'Book a free consult' }) {
  return (
    <footer className="relative bg-black text-white border-t border-white/10 overflow-hidden">
      {/* Closing conversion moment — the last thing every visitor sees
          is the brand promise and one more way in. */}
      <div className="max-w-6xl mx-auto px-6 pt-20 pb-14 md:pt-28 md:pb-20">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-8 pb-14 md:pb-20 border-b border-white/10">
          <h2 className="font-display uppercase text-[clamp(2.6rem,7vw,5.5rem)] leading-[0.95] tracking-tight max-w-3xl">
            Ready when
            <br />
            you are.
          </h2>
          <a href={ctaHref} className="lp-btn shrink-0">
            {ctaLabel}
            <span className="lp-btn-arrow" aria-hidden="true">→</span>
          </a>
        </div>

        <div className="grid md:grid-cols-3 gap-10 text-sm pt-14">
          <div>
            <div className="font-display text-xl tracking-widest mb-4">UN1T DUBLIN</div>
            <p className="text-white/55 leading-relaxed max-w-xs">
              Coach-led strength &amp; conditioning. Built for racing.
              We train as one.
            </p>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-white/45 font-semibold mb-4">Studios</div>
            <p className="leading-loose">
              <Link href="/welcome/stillorgan" className="text-white/80 hover:text-white transition-colors">
                UN1T Stillorgan
              </Link>
              <br />
              <Link href="/welcome/hatch-street" className="text-white/80 hover:text-white transition-colors">
                UN1T Hatch Street
              </Link>
            </p>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-white/45 font-semibold mb-4">Get in touch</div>
            <p className="leading-loose">
              <a href={ctaHref} className="text-white/80 hover:text-white transition-colors">{ctaLabel}</a>
              <br />
              <a
                href="https://instagram.com/un1tdublin"
                target="_blank"
                rel="noreferrer"
                className="text-white/80 hover:text-white transition-colors"
              >
                @un1tdublin on Instagram
              </a>
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-white/45">
          <span>© {new Date().getFullYear()} UN1T Dublin. All rights reserved.</span>
          <span className="flex items-center gap-6">
            <Link href="/privacy" className="hover:text-white/80 transition-colors">Privacy</Link>
            <Link href="/login" className="hover:text-white/80 transition-colors">Member &amp; staff login</Link>
          </span>
        </div>
      </div>
    </footer>
  )
}
