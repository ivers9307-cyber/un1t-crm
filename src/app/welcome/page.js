// /welcome — public marketing landing page (Phase 2 of the eventual
// un1tdublin.com customer-acquisition surface).
//
// Phase 1 was hand-coded React with all copy + media inlined. Phase 2
// (mig 126) lifts the operator-tweakable bits — hero copy, hero image,
// booking-form slug, value-prop pillars, stats, testimonial — into the
// `landing_page_settings` table so master/owner can edit them from
// /settings/landing-page without a redeploy.
//
// Render strategy: read the settings row, merge field-by-field with
// the hard-coded DEFAULTS below. Any NULL/empty column falls back to
// its default so the page never renders blank — even before an
// operator has saved anything, the public surface ships a polished
// default state. (DEFAULTS here MUST match those in
// LandingPageSettingsForm.jsx so the form pre-fills with whatever
// the unedited public page is currently showing.)
//
// Conversion-first layout (unchanged from Phase 1):
//   1. Compact hero with a single headline (no two-CTA distraction)
//   2. Embedded booking widget IMMEDIATELY below — the form is the
//      first thing visitors see above the fold, not buried at the
//      bottom. This is the conversion goal of the page.
//   3. Value-prop pillars + social proof live BELOW the form for
//      visitors who want more context before booking.
//   4. Footer.

import Link from 'next/link'
import BookingWidget from '@/components/BookingWidget'
import { createServerClient } from '@/lib/supabase'

// SINGLE SOURCE OF TRUTH for the default copy + media. Mirrored in
// LandingPageSettingsForm.jsx — keep these in sync so the operator
// form pre-fills with whatever the unedited public page renders.
const DEFAULTS = {
  hero_eyebrow:   'Stillorgan, Dublin',
  hero_headline:  'Train with intent.',
  hero_subhead:   'Race with proof.',
  hero_subtext:
    'Coach-led strength & conditioning, built for racing. Beginners welcome — book a free 30-minute consultation below.',
  // The default booking slug. Operator can swap to "free-trial-class"
  // or any other active booking type from the settings page.
  booking_slug:   'consultation',
  hero_image_url: null,
  pillars: [
    { number: '01', title: 'Coach-led, every session', body: "A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught." },
    { number: '02', title: 'Race-ready conditioning', body: "Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes." },
    { number: '03', title: 'A room that shows up',    body: 'Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment.' },
  ],
  stats: [
    { number: '200+', label: 'Members training every week' },
    { number: '6',    label: 'Race events hosted in 2025' },
    { number: '4.9',  label: 'Average member rating' },
  ],
  testimonial_quote:
    "The coaching is what separates UN1T from any gym I've trained at. I came in for a Hyrox PB. I stayed for the room.",
  testimonial_author: 'Member, joined 2024',
}

// Merge a DB row over DEFAULTS — empty strings count as "use default"
// so clearing a field in the operator form restores the polished
// public default rather than rendering blank. JSONB columns
// (pillars, stats) only override if the saved array is non-empty.
function withFallbacks(row) {
  if (!row) return { ...DEFAULTS }
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = row[k]
    if (Array.isArray(DEFAULTS[k])) {
      if (Array.isArray(v) && v.length > 0) out[k] = v
    } else if (k === 'hero_image_url') {
      out[k] = v || null
    } else if (typeof v === 'string' && v.trim().length > 0) {
      out[k] = v
    }
  }
  return out
}

// Today UN1T has one marketing-active location. Multi-location
// hostname routing is a future Phase — when that lands, this becomes
// a hostname (or location_id query param) → row picker. For now,
// take the most-recently-updated row so whichever location's owner
// last edited their landing page wins.
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

// Per-request metadata so an operator-edited hero image becomes the
// og:image used by WhatsApp / Slack / Twitter link previews. Title
// + description stay on the SEO-stable strings to avoid an operator
// accidentally tanking search rank with a pithy headline.
export async function generateMetadata() {
  const s = withFallbacks(await loadSettings())
  const title = 'UN1T Dublin — Strength + conditioning, built for racing'
  const description = s.hero_subtext
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: 'UN1T Dublin',
      type: 'website',
      ...(s.hero_image_url ? { images: [{ url: s.hero_image_url }] } : {}),
    },
  }
}

export default async function WelcomePage() {
  const s = withFallbacks(await loadSettings())

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      {/* ── Top nav ───────────────────────────────────────────── */}
      <header className="absolute inset-x-0 top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="text-xl font-black tracking-widest">UN1T</div>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
            <a href="#offer"  className="text-white/70 hover:text-white transition-colors">What we do</a>
            <a href="#proof"  className="text-white/70 hover:text-white transition-colors">Members</a>
          </nav>
        </div>
      </header>

      {/* ── Hero — compact, single-headline, immediately above the
          booking form so the form is in the visitor's first
          eye-line. ───────────────────────────────────────────── */}
      <section className="relative pt-24 pb-8 md:pt-32 md:pb-10 overflow-hidden">
        {/* When the operator has uploaded a hero image, layer it
            behind the headline with a darkening overlay so the white
            text stays legible. Otherwise fall back to the original
            radial-gradient — pure CSS, no image needed. */}
        {s.hero_image_url ? (
          <>
            <div
              className="absolute inset-0 pointer-events-none bg-cover bg-center"
              style={{ backgroundImage: `url(${s.hero_image_url})` }}
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
          <p className="text-xs md:text-sm uppercase tracking-[0.3em] text-white/60 mb-5">
            {s.hero_eyebrow}
          </p>
          <h1 className="text-4xl md:text-6xl font-black leading-[1.05] tracking-tight mb-4">
            {s.hero_headline}
            <br />
            <span className="text-white/70">{s.hero_subhead}</span>
          </h1>
          <p className="text-base md:text-lg text-white/70 max-w-2xl mx-auto leading-relaxed">
            {s.hero_subtext}
          </p>
        </div>
      </section>

      {/* ── Booking section — the conversion target, top of page ── */}
      <section id="book" className="bg-black pt-2 pb-20 md:pb-28">
        <div className="max-w-6xl mx-auto px-6">
          {/* BookingWidget is the same one served at /book/[slug].
              Embedding it here means the marketing page and the
              shareable booking link share a single source of truth —
              one form to maintain, edit it from /bookings/event-types
              and the changes land everywhere. */}
          <div className="flex justify-center">
            <BookingWidget slug={s.booking_slug} />
          </div>
          <p className="text-center text-xs text-white/50 mt-6">
            Or just walk in &mdash; we&apos;re at <span className="text-white/80">UN1T Stillorgan, Dublin</span>.
          </p>
        </div>
      </section>

      {/* ── What we do (3 value props) — for visitors who scroll ── */}
      <section id="offer" className="bg-white text-black py-20 md:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <div className="max-w-2xl mb-16">
            <p className="text-xs uppercase tracking-[0.3em] text-black/50 mb-4">What we do</p>
            <h2 className="text-3xl md:text-5xl font-black leading-tight">
              Built for the work that gets you across the finish line.
            </h2>
          </div>

          {/* Render exactly the first 3 pillars — the layout grid
              is fixed to 3 columns. The settings form caps at 3 too,
              so this slice is defensive against a hand-edited row. */}
          <div className="grid md:grid-cols-3 gap-px bg-black/10">
            {s.pillars.slice(0, 3).map((p, i) => (
              <Pillar
                key={i}
                number={p.number || ''}
                title={p.title || ''}
                body={p.body || ''}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── Social proof ───────────────────────────────────────── */}
      <section id="proof" className="bg-black text-white py-20 md:py-28 border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-12 text-center">
            {s.stats.slice(0, 3).map((stat, i) => (
              <Stat key={i} number={stat.number || ''} label={stat.label || ''} />
            ))}
          </div>

          <blockquote className="max-w-3xl mx-auto mt-20 text-center">
            <p className="text-2xl md:text-3xl font-medium leading-snug text-white/90">
              &ldquo;{s.testimonial_quote}&rdquo;
            </p>
            <footer className="mt-6 text-sm uppercase tracking-widest text-white/60">
              &mdash; {s.testimonial_author}
            </footer>
          </blockquote>

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

function Pillar({ number, title, body }) {
  return (
    <div className="bg-white p-8 md:p-10">
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
