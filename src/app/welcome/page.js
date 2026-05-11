// /welcome — public marketing landing page (Phase 3b: block-based,
// reorderable). The visible page sits between a fixed top nav and a
// fixed footer; everything in between is an ordered array of typed
// blocks rendered from landing_page_settings.blocks.
//
// Block types live in src/lib/landing-page-blocks.js (single source
// of truth shared by the renderer, the operator form, and the API
// validator). Adding a new block type is a 3-file change: register
// it there, add a renderer below, and add an edit panel in the
// LandingPageSettingsForm.
//
// Render selection — blocksOrDefault() handles the picky cases:
//   - No row in DB           → starter set (default hero/booking/
//                              pillars/stats/testimonial)
//   - Row with NULL blocks   → backfilled by mig 128 from flat
//                              columns; won't hit the default path
//   - Row with malformed     → bad blocks filtered out, defaults
//     blocks                   used if NONE survive (defensive
//                              against a hand-edited row)

import Link from 'next/link'
import BookingWidget from '@/components/BookingWidget'
import { createServerClient } from '@/lib/supabase'
import { parseEmbed } from '@/lib/landing-page-embed'
import { blocksOrDefault } from '@/lib/landing-page-blocks'

// Today UN1T has one marketing-active location. Multi-location
// hostname routing is a future Phase — for now take the most
// recently-updated row so whichever location's owner last edited
// the page wins.
async function loadSettings() {
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return null
    return data || null
  } catch {
    // Never let a settings fetch failure 500 the public marketing
    // page — degrade silently to defaults. The /welcome page is the
    // top of the funnel; brokenness here costs us leads.
    return null
  }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Per-request metadata. Pull og:image from the first hero block's
// image (operator-uploaded photos show up in WhatsApp / Slack link
// previews). Title + description stay on SEO-stable strings to
// avoid an operator accidentally tanking search rank with a pithy
// headline.
export async function generateMetadata() {
  const row = await loadSettings()
  const blocks = blocksOrDefault(row?.blocks)
  const hero = blocks.find((b) => b.type === 'hero')
  const heroImage = hero?.image_url || null
  const description = hero?.subtext
    || 'Coach-led training for athletes and ambitious beginners. Hyrox-style strength + conditioning at our Stillorgan studio. Book your free consultation.'
  const title = 'UN1T Dublin — Strength + conditioning, built for racing'
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: 'UN1T Dublin',
      type: 'website',
      ...(heroImage ? { images: [{ url: heroImage }] } : {}),
    },
  }
}

export default async function WelcomePage() {
  const row = await loadSettings()
  const blocks = blocksOrDefault(row?.blocks)
  // Site chrome (mig 129) — logo lives outside the blocks array
  // because it always renders regardless of section ordering.
  const logoUrl     = row?.logo_url || null
  const logoAlt     = row?.logo_alt || 'UN1T Dublin'
  const logoWidthPx = row?.logo_width_px || 96

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      {/* ── Top nav ───────────────────────────────────────────── */}
      <header className="absolute inset-x-0 top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={logoAlt}
              style={{ maxWidth: `${logoWidthPx}px` }}
              className="h-10 w-auto object-contain"
            />
          ) : (
            <div className="text-xl font-black tracking-widest">UN1T</div>
          )}
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
            <a href="#book"  className="text-white/70 hover:text-white transition-colors">Book</a>
          </nav>
        </div>
      </header>

      {/* ── Blocks (ordered, operator-managed) ────────────────── */}
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} />
      ))}

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="bg-black text-white border-t border-white/10 py-12">
        <div className="max-w-6xl mx-auto px-6 grid md:grid-cols-3 gap-10 text-sm">
          <div>
            <div className="text-lg font-black tracking-widest mb-3">UN1T DUBLIN</div>
            <p className="text-white/60 leading-relaxed">
              Strength &amp; conditioning. Hyrox-style training. Coach-led.
            </p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-white/50 mb-3">Find us</div>
            <p className="text-white/80 leading-relaxed">
              UN1T Stillorgan
              <br />
              Stillorgan, Co. Dublin
              <br />
              Ireland
            </p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-white/50 mb-3">Get in touch</div>
            <p className="text-white/80 leading-relaxed">
              <a href="#book" className="hover:text-white">Book a free consultation</a>
              <br />
              <a href="https://instagram.com/un1tdublin" target="_blank" rel="noreferrer" className="hover:text-white">@un1tdublin on Instagram</a>
            </p>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-6 mt-12 pt-8 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-white/50">
          <span>© {new Date().getFullYear()} UN1T Dublin. All rights reserved.</span>
          <Link href="/login" className="hover:text-white/80">Member &amp; staff login</Link>
        </div>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Block renderer — type-dispatch. Add a case here whenever a new
// block type lands in landing-page-blocks.js. Unknown types render
// nothing rather than throwing — operators can occasionally end up
// with a stray block from a half-rolled-back deploy and we don't
// want to take down the marketing page.
// ─────────────────────────────────────────────────────────────

function BlockRenderer({ block }) {
  switch (block.type) {
    case 'hero':        return <HeroBlock        block={block} />
    case 'booking':     return <BookingBlock     block={block} />
    case 'pillars':     return <PillarsBlock     block={block} />
    case 'gallery':     return <GalleryBlock     block={block} />
    case 'embed':       return <EmbedBlock       block={block} />
    case 'stats':       return <StatsBlock       block={block} />
    case 'testimonial': return <TestimonialBlock block={block} />
    default:            return null
  }
}

// Hero — backdrop precedence: video > image > radial gradient.
// Video uses the image as poster so the hero never flashes black
// while the video downloads.
function HeroBlock({ block }) {
  return (
    <section className="relative pt-24 pb-8 md:pt-32 md:pb-10 overflow-hidden">
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
                'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.7) 60%, rgba(0,0,0,0.95) 100%)',
            }}
            aria-hidden="true"
          />
        </>
      ) : block.image_url ? (
        <>
          <div
            className="absolute inset-0 pointer-events-none bg-cover bg-center"
            style={{ backgroundImage: `url(${block.image_url})` }}
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.7) 60%, rgba(0,0,0,0.95) 100%)',
            }}
            aria-hidden="true"
          />
        </>
      ) : (
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 30%, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0) 60%)',
          }}
          aria-hidden="true"
        />
      )}
      <div className="relative max-w-5xl mx-auto px-6 text-center">
        {block.eyebrow && (
          <p className="text-xs md:text-sm uppercase tracking-[0.3em] text-white/60 mb-5">
            {block.eyebrow}
          </p>
        )}
        {(block.headline || block.subhead) && (
          <h1 className="text-4xl md:text-6xl font-black leading-[1.05] tracking-tight mb-4">
            {block.headline}
            {block.subhead && (
              <>
                <br />
                <span className="text-white/70">{block.subhead}</span>
              </>
            )}
          </h1>
        )}
        {block.subtext && (
          <p className="text-base md:text-lg text-white/70 max-w-2xl mx-auto leading-relaxed">
            {block.subtext}
          </p>
        )}
      </div>
    </section>
  )
}

function BookingBlock({ block }) {
  return (
    <section id="book" className="bg-black pt-2 pb-20 md:pb-28">
      <div className="max-w-6xl mx-auto px-6">
        <div className="flex justify-center">
          {block.slug ? (
            <BookingWidget slug={block.slug} />
          ) : (
            <p className="text-white/50 text-sm">Booking form not configured.</p>
          )}
        </div>
        <p className="text-center text-xs text-white/50 mt-6">
          Or just walk in &mdash; we&apos;re at <span className="text-white/80">UN1T Stillorgan, Dublin</span>.
        </p>
      </div>
    </section>
  )
}

function PillarsBlock({ block }) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 3) : []
  if (items.length === 0) return null
  return (
    <section className="bg-white text-black py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid md:grid-cols-3 gap-px bg-black/10">
          {items.map((p, i) => (
            <Pillar
              key={i}
              number={p.number || ''}
              title={p.title || ''}
              body={p.body || ''}
              photoUrl={p.photo_url || null}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function GalleryBlock({ block }) {
  const items = Array.isArray(block.items) ? block.items : []
  if (items.length === 0) return null
  return (
    <section className="bg-black py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        {block.title && (
          <p className="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">{block.title}</p>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
          {items.map((g, i) => (
            <figure key={i} className="relative aspect-square overflow-hidden bg-white/5 group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={g.url}
                alt={g.alt || ''}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                loading="lazy"
              />
              {g.caption && (
                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-xs text-white/90">
                  {g.caption}
                </figcaption>
              )}
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}

function EmbedBlock({ block }) {
  const embed = parseEmbed(block.url)
  if (!embed) return null
  return (
    <section className="bg-black py-20 md:py-28 border-t border-white/10">
      <div className="max-w-4xl mx-auto px-6">
        {block.title && (
          <p className="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">{block.title}</p>
        )}
        {/* 16:9 wrapper for YouTube; Instagram embeds use a taller
            portrait aspect for reels — we let IG decide its own
            height inside its own iframe. */}
        <div
          className={
            embed.provider === 'instagram'
              ? 'relative w-full max-w-md mx-auto'
              : 'relative w-full aspect-video bg-white/5'
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
        {block.caption && (
          <p className="text-center text-sm text-white/60 mt-4">{block.caption}</p>
        )}
      </div>
    </section>
  )
}

function StatsBlock({ block }) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 3) : []
  if (items.length === 0) return null
  return (
    <section className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid md:grid-cols-3 gap-12 text-center">
          {items.map((s, i) => (
            <Stat key={i} number={s.number || ''} label={s.label || ''} />
          ))}
        </div>
        <div className="text-center mt-14">
          <a
            href="#book"
            className="inline-flex items-center gap-2 bg-white text-black font-semibold text-sm md:text-base px-6 py-3 md:px-8 md:py-4 rounded-full hover:bg-white/90 transition-colors"
          >
            Book your free consultation
            <span aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </section>
  )
}

function TestimonialBlock({ block }) {
  if (!block.quote && !block.author) return null
  return (
    <section className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        <blockquote className="max-w-3xl mx-auto text-center">
          {block.quote && (
            <p className="text-2xl md:text-3xl font-medium leading-snug text-white/90">
              &ldquo;{block.quote}&rdquo;
            </p>
          )}
          {block.author && (
            <footer className="mt-6 text-sm uppercase tracking-widest text-white/60">
              &mdash; {block.author}
            </footer>
          )}
        </blockquote>
      </div>
    </section>
  )
}

function Pillar({ number, title, body, photoUrl }) {
  return (
    <div className="bg-white p-8 md:p-10">
      {photoUrl && (
        <div className="aspect-[4/3] mb-6 overflow-hidden -mx-8 -mt-8 md:-mx-10 md:-mt-10 bg-black/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}
      <div className="text-xs font-mono text-black/40 mb-6">{number}</div>
      <h3 className="text-xl md:text-2xl font-black mb-3 leading-tight">{title}</h3>
      <p className="text-black/70 leading-relaxed">{body}</p>
    </div>
  )
}

function Stat({ number, label }) {
  return (
    <div>
      <div className="text-5xl md:text-6xl font-black tracking-tight mb-2">{number}</div>
      <div className="text-sm uppercase tracking-widest text-white/60">{label}</div>
    </div>
  )
}
