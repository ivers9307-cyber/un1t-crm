// /welcome — public marketing landing page. Phase 1 of the eventual
// un1tdublin.com customer-acquisition surface (the apex domain still
// points at the old site today; we'll flip the routing once DNS is
// ready — see middleware comment for hostname-based routing path).
//
// Design philosophy:
//   - Brand-aligned with the rest of UN1T's visual identity
//     (black + white, bold geometric sans, generous negative space)
//   - Single conversion goal — book a free consultation. Every
//     section either reinforces credibility or moves the visitor
//     toward the embedded booking widget further down.
//   - Mobile-first — most members find their gym from a phone.
//
// Editing today: hand-coded React. Phase 2 will surface a sidebar
// "Landing page settings" form so operators can edit hero copy + CTA
// + hero image + visible value-prop bullets without touching code.
// Until then, ping Claude / edit this file directly.

import Link from 'next/link'
import BookingWidget from '@/components/BookingWidget'

// SINGLE SOURCE OF TRUTH for which booking type the landing page
// embeds. Change this string to swap the form (e.g. swap to
// "free-trial-class" if running a different acquisition campaign).
// Must match the slug of an active event_type in your bookings.
//
// In Phase 2 this becomes editable from the sidebar settings page;
// for now it's a one-line edit + redeploy.
const BOOKING_SLUG = 'consultation'

export const metadata = {
  title: 'UN1T Dublin — Strength + conditioning, built for racing',
  description:
    'Coach-led training for athletes and ambitious beginners. Hyrox-style strength + conditioning at our Stillorgan studio. Book your free consultation.',
  openGraph: {
    title: 'UN1T Dublin — Strength + conditioning, built for racing',
    description:
      'Coach-led training for athletes and ambitious beginners. Hyrox-style strength + conditioning at our Stillorgan studio. Book your free consultation.',
    siteName: 'UN1T Dublin',
    type: 'website',
  },
}

// Public — no auth gate.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function WelcomePage() {
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      {/* ── Top nav ───────────────────────────────────────────── */}
      <header className="absolute inset-x-0 top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="text-xl font-black tracking-widest">UN1T</div>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
            <a href="#offer"  className="text-white/70 hover:text-white transition-colors">What we do</a>
            <a href="#proof"  className="text-white/70 hover:text-white transition-colors">Members</a>
            <a href="#book"   className="text-white/70 hover:text-white transition-colors">Visit us</a>
          </nav>
          <a
            href="#book"
            className="text-xs font-semibold uppercase tracking-wider bg-white text-black px-4 py-2 rounded-full hover:bg-white/90 transition-colors"
          >
            Book a free intro
          </a>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="relative pt-32 pb-24 md:pt-44 md:pb-36 overflow-hidden">
        {/* Subtle radial glow behind the headline so the page doesn't
            look like a slab of black. Pure CSS — no image needed. */}
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 30%, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0) 60%)',
          }}
        />
        <div className="relative max-w-5xl mx-auto px-6 text-center">
          <p className="text-xs md:text-sm uppercase tracking-[0.3em] text-white/60 mb-6">
            Stillorgan, Dublin
          </p>
          <h1 className="text-5xl md:text-7xl font-black leading-[1.05] tracking-tight mb-6">
            Train with intent.
            <br />
            <span className="text-white/70">Race with proof.</span>
          </h1>
          <p className="text-lg md:text-xl text-white/70 max-w-2xl mx-auto mb-10 leading-relaxed">
            Coach-led strength and conditioning, built around the demands of competitive racing. Open to anyone serious about getting better — beginners welcome.
          </p>
          <div className="flex items-center justify-center gap-3">
            <a
              href="#book"
              className="inline-flex items-center gap-2 bg-white text-black font-semibold text-sm md:text-base px-6 py-3 md:px-8 md:py-4 rounded-full hover:bg-white/90 transition-colors"
            >
              Book a free consultation
              <span aria-hidden="true">→</span>
            </a>
            <a
              href="#offer"
              className="inline-flex items-center gap-2 text-white/80 font-medium text-sm md:text-base px-4 py-3 hover:text-white transition-colors"
            >
              See what we do
            </a>
          </div>
        </div>
      </section>

      {/* ── What we do (3 value props) ─────────────────────────── */}
      <section id="offer" className="bg-white text-black py-20 md:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <div className="max-w-2xl mb-16">
            <p className="text-xs uppercase tracking-[0.3em] text-black/50 mb-4">What we do</p>
            <h2 className="text-3xl md:text-5xl font-black leading-tight">
              Built for the work that gets you across the finish line.
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-px bg-black/10">
            <Pillar
              number="01"
              title="Coach-led, every session"
              body="A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught."
            />
            <Pillar
              number="02"
              title="Race-ready conditioning"
              body="Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes."
            />
            <Pillar
              number="03"
              title="A room that shows up"
              body="Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment."
            />
          </div>
        </div>
      </section>

      {/* ── Social proof ───────────────────────────────────────── */}
      <section id="proof" className="bg-black text-white py-20 md:py-28 border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-12 text-center">
            <Stat number="200+" label="Members training every week" />
            <Stat number="6"    label="Race events hosted in 2025" />
            <Stat number="4.9"  label="Average member rating" />
          </div>

          <blockquote className="max-w-3xl mx-auto mt-20 text-center">
            <p className="text-2xl md:text-3xl font-medium leading-snug text-white/90">
              &ldquo;The coaching is what separates UN1T from any gym I've trained at. I came in for a Hyrox PB. I stayed for the room.&rdquo;
            </p>
            <footer className="mt-6 text-sm uppercase tracking-widest text-white/60">
              — Member, joined 2024
            </footer>
          </blockquote>
        </div>
      </section>

      {/* ── Booking section (the conversion target) ────────────── */}
      <section id="book" className="bg-gray-50 text-black py-20 md:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <p className="text-xs uppercase tracking-[0.3em] text-black/50 mb-4">Visit us</p>
            <h2 className="text-3xl md:text-5xl font-black leading-tight mb-4">
              Book your free consultation
            </h2>
            <p className="text-base md:text-lg text-black/70 max-w-2xl mx-auto">
              30 minutes with a coach. Tour the studio, ask questions, see if UN1T is the right fit. No pressure to sign up.
            </p>
          </div>

          {/* BookingWidget is the same one served at /book/[slug].
              Embedding it here means the marketing page and the
              shareable booking link share a single source of truth —
              one form to maintain, edit it from /bookings/event-types
              and the changes land everywhere. */}
          <div className="flex justify-center">
            <BookingWidget slug={BOOKING_SLUG} />
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
