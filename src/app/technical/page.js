// /technical — public B2B service page for Repset, the communications
// platform (the software Champ Fitness Ltd builds and provides to UN1T
// gym franchises). Repset is the software brand; UN1T is the gym brand
// the software is operated for — keep the two distinct in all copy.
//
// LEGALENT.1 — the LEGAL ENTITY named here is Champ Fitness Ltd
// (trading as UN1T Dublin), the entity settled in SAAS4-W0.2 and the
// one /terms, /privacy, /privacy/members and
// /legal/subprocessors already name. This page used to name a
// different (and likely non-existent) company formed from the gym
// brand — on the very page Meta cross-checks against the Tech
// Provider Access Verification form. "UN1T Dublin" as a gym BRAND is
// correct and stays; only the registered-company claims changed.
// tests/legal-entity-consistency.test.js pins it.
//
// This page is the website URL cited in Meta's Tech Provider Access
// Verification: Meta requires a live page showing the service the
// business described (unified WhatsApp + Instagram messaging on top of
// the gym CRM) and details of the business providing it. Keep the copy
// here consistent with the Access Verification form and the App Review
// submissions — reviewers cross-check them.
//
// Fully static, no DB reads, no client state. Standalone top-level
// route, so it must be in the public allowlist in THREE places:
// src/proxy.js publicPaths, src/lib/brands.js allowedPaths
// (un1t-marketing), and src/components/AppShell.jsx PUBLIC_PATHS.
// All three are done.
//
// Visual language matches the marketing site (WEBSITE-REDESIGN
// 2026-06): black, Poppins display type at heavy weights, lp-reveal
// scroll entrances. Poppins is loaded in-page (the /event/[slug]
// pattern) because this route sits outside the /welcome segment and
// its layout; the wrapper carries id="lp-shell" so RevealArmScript
// can arm the reveal system, exactly as the /welcome layout does.

import Link from 'next/link'
import { poppinsBody as poppins } from '@/fonts/poppins'
import { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'

export const runtime = 'nodejs'

export const metadata = {
  title: 'Repset · Technology',
  description:
    'Repset — a gym CRM with WhatsApp and Instagram messaging in one shared inbox, built and provided by Champ Fitness Ltd (trading as UN1T Dublin) to UN1T gym franchises.',
}

// Repset brand volt — the accent that closes the wordmark's full stop
// (see public/repset-mark.svg and the TV challenge board, which share it).
const VOLT = '#D6FF3D'

const CONTACT = { href: 'mailto:hello@un1tdublin.com', label: 'Talk to us' }

// Numbered feature rows, in the pillars idiom of the studio pages but
// text-only — this surface sells software, not sessions.
const FEATURES = [
  {
    number: '01',
    title: 'One shared inbox',
    body: 'Every WhatsApp and Instagram message a gym receives lands in one shared inbox, linked to the right member record. Any coach or front-of-house staff member can pick up the conversation with full context — nothing lives in one person’s phone.',
  },
  {
    number: '02',
    title: 'A CRM built for gyms',
    body: 'Members, leads, bookings, memberships, payments and communications in one system — the same platform our own coaches use every day to run the UN1T studios in Dublin.',
  },
  {
    number: '03',
    title: 'An assistant that knows when to hand over',
    body: 'An optional AI assistant answers common questions and helps members book classes and consultations over WhatsApp. Staff see every conversation and can take over at any time, and sensitive actions wait for a human’s approval.',
  },
  {
    number: '04',
    title: 'Booking where the conversation is',
    body: 'Members can book a class or a consultation without leaving the chat, then get their confirmations and reminders in the same thread.',
  },
]

// Data-handling commitments, stated plainly for gym owners (and for
// the Meta reviewers who visit this page during Access Verification).
const DATA_POINTS = [
  'Messages and message details are used only to show conversations to that gym’s own staff, send their replies, and match messages to the right member record.',
  'Each gym’s data stays its own — one gym’s conversations and members are never visible to another.',
  'We never sell data. Marketing messages go only to people who opted in, and opt-outs are honoured automatically.',
  'Each gym connects its own WhatsApp Business number and Instagram account, and remains the owner of its number, its account and its customer relationships.',
]

export default function TechnicalPage() {
  return (
    <div
      id="lp-shell"
      suppressHydrationWarning
      className={`${poppins.variable} font-body min-h-screen bg-black text-white antialiased`}
    >
      <RevealArmScript />
      <RevealManager />
      <SiteHeader logoUrl="/repset-mark.svg" logoAlt="Repset" logoWidthPx={44} sticky ctaHref={CONTACT.href} ctaLabel={CONTACT.label} />

      {/* ── Hero ────────────────────────────────────────────────── */}
      <section className="relative pt-36 pb-20 md:pt-48 md:pb-28 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-6">
          <p className="lp-reveal text-[11px] uppercase tracking-[0.3em] text-white/45 font-semibold mb-6">
            Champ Fitness Ltd · Technology
          </p>
          <div className="lp-reveal lp-d1 font-display font-extrabold lowercase text-3xl md:text-4xl tracking-tight mb-5">
            repset<span style={{ color: VOLT }} aria-hidden="true">.</span>
          </div>
          <h1 className="lp-reveal lp-d1 font-display font-extrabold uppercase text-[clamp(2.4rem,7vw,5.5rem)] leading-[1.02] tracking-tight max-w-4xl">
            The platform
            <br />
            that runs UN1T.
          </h1>
          <p className="lp-reveal lp-d2 mt-8 text-lg md:text-xl text-white/70 leading-relaxed max-w-2xl">
            Repset is a CRM for the whole gym — with every WhatsApp and
            Instagram conversation in a single shared inbox. Built by UN1T
            Dublin to run our own studios, and offered to UN1T gym franchises
            in Ireland, the UK, Australia and Cyprus.
          </p>
          <div className="lp-reveal lp-d3 mt-10 flex flex-wrap items-center gap-4">
            <a href={CONTACT.href} className="lp-btn">
              {CONTACT.label}
              <span className="lp-btn-arrow" aria-hidden="true">→</span>
            </a>
            <a href="#platform-data" className="lp-btn-ghost">How we handle data</a>
          </div>
        </div>
      </section>

      {/* ── What the platform does ──────────────────────────────── */}
      <section id="platform" className="py-20 md:py-28 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="lp-reveal font-display font-extrabold uppercase text-[clamp(1.9rem,5vw,3.5rem)] leading-[1.05] tracking-tight max-w-3xl">
            Run the gym from
            <br />
            one place.
          </h2>
          <div className="mt-14 grid md:grid-cols-2 gap-x-12 gap-y-14">
            {FEATURES.map((f) => (
              <div key={f.number} className="lp-reveal">
                <div className="text-[11px] uppercase tracking-[0.3em] text-white/45 font-semibold mb-3">{f.number}</div>
                <h3 className="font-display font-bold text-xl md:text-2xl tracking-tight mb-3">{f.title}</h3>
                <p className="text-white/60 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Platform data handling ──────────────────────────────── */}
      <section id="platform-data" className="py-20 md:py-28 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-6 grid md:grid-cols-[1fr,1.4fr] gap-12">
          <div>
            <h2 className="lp-reveal font-display font-extrabold uppercase text-[clamp(1.9rem,5vw,3.5rem)] leading-[1.05] tracking-tight">
              Your gym&rsquo;s data
              <br />
              stays yours.
            </h2>
            <p className="lp-reveal lp-d1 mt-6 text-white/60 leading-relaxed">
              Repset connects to WhatsApp and Instagram through
              Meta&rsquo;s official APIs. We act as the technology provider —
              nothing more.
            </p>
          </div>
          <ul className="space-y-6">
            {DATA_POINTS.map((point, i) => (
              <li key={i} className="lp-reveal flex gap-4">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/70" aria-hidden="true" />
                <span className="text-white/70 leading-relaxed">{point}</span>
              </li>
            ))}
            <li className="lp-reveal pt-2 text-sm text-white/50 leading-relaxed">
              Full details in our{' '}
              <Link href="/privacy" className="underline text-white/70 hover:text-white transition-colors">Privacy Policy</Link>,{' '}
              <Link href="/privacy/authority-requests" className="underline text-white/70 hover:text-white transition-colors">
                policy on requests from authorities
              </Link>{' '}
              and{' '}
              <Link href="/terms" className="underline text-white/70 hover:text-white transition-colors">Terms of Service</Link>.
            </li>
          </ul>
        </div>
      </section>

      {/* ── Who we are / contact ────────────────────────────────── */}
      <section id="contact" className="py-20 md:py-28">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="lp-reveal font-display font-extrabold uppercase text-[clamp(1.9rem,5vw,3.5rem)] leading-[1.05] tracking-tight max-w-3xl">
            Built by operators,
            <br />
            not just developers.
          </h2>
          <p className="lp-reveal lp-d1 mt-8 text-white/70 leading-relaxed max-w-2xl">
            Champ Fitness Ltd, trading as UN1T Dublin, is registered in
            Ireland. We operate the UN1T studios in Dublin — Stillorgan and
            Hatch Street — and we build and run Repset, the software platform
            behind them. Every feature exists because a real gym needed it.
          </p>
          <p className="lp-reveal lp-d2 mt-4 text-white/70 leading-relaxed max-w-2xl">
            Interested in Repset for your UN1T franchise? Email{' '}
            <a href={CONTACT.href} className="underline text-white hover:text-white/80 transition-colors">
              hello@un1tdublin.com
            </a>
            .
          </p>
        </div>
      </section>

      <SiteFooter ctaHref={CONTACT.href} ctaLabel={CONTACT.label} />
    </div>
  )
}
