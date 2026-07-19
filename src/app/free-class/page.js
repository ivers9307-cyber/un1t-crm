// /free-class — UN1T Stillorgan paid-traffic campaign landing page.
//
// Dedicated landing page for the Meta "3 free classes" ad. The CRM's
// landing_page_settings table is one-row-per-location (PK =
// location_id), so a second Stillorgan page can't live there — this is
// a code-defined page that reuses the SAME block renderers as the
// operator-editable pages for visual parity.
//
// Leads post to /api/public/leads with public_path='stillorgan' plus
// the 'stillorgan-free-class' campaign key (see LEAD_CAMPAIGNS in
// src/lib/leads.js). The route resolves the studio from public_path and
// applies the campaign's own nurture tag + lead_source, so these leads
// attribute to Stillorgan distinctly from the organic /stillorgan page
// — no editable row required, and the client can't inject either value.
//
// Meta Pixel + the 'Lead' conversion event come for free: this page is
// served on the un1tdublin.com marketing host, where the root-layout
// CookieConsent island loads the pixel (on marketing consent) and
// WaitlistWidget fires 'Lead' on submit.
//
// Public reachability: '/free-class' is allowlisted in src/lib/brands.js
// (un1t-marketing brand), src/proxy.js, and src/components/AppShell.jsx
// — the three gates a logged-out visitor passes through. noindex keeps
// this paid LP out of organic search so it doesn't compete with the
// main marketing site.

import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'

// SAAS-7 — the header logo resolves from Stillorgan's
// landing_page_settings row (the operator-editable source /stillorgan
// itself renders) with the old hardcoded URL as fallback; live value is
// identical today, so paid traffic sees no change. force-dynamic so the
// lookup runs per-request (matching /start and /stillorgan) instead of
// baking a build-time value.
export const dynamic = 'force-dynamic'

// Single conversion target — the hero CTA, sticky-header CTA and footer
// CTA all scroll to the lead form (#waitlist, the id LeadFormBlock sets).
const CTA = { href: '#waitlist', label: 'Get my 3 free classes' }

// Blocks rendered top-to-bottom. Hero + lead form carry the offer; the
// pillars / stats / testimonial reuse the live Stillorgan page's real
// content (member photos, numbers, and Simon's review) for social proof.
const BLOCKS = [
  {
    id: 'free-class-hero',
    type: 'hero',
    eyebrow: 'Stillorgan, Dublin',
    headline: 'YOUR FIRST 3 CLASSES ARE FREE',
    subhead: 'COACH-LED STRENGTH & CONDITIONING',
    subtext:
      'Every class at UN1T Stillorgan is coached start to finish — the programming, your form, the push when you need it. Come try three on us. No membership, no pressure.',
    image_url: null,
    video_url: null,
  },
  {
    id: 'free-class-lead-form',
    type: 'lead_form',
    heading: 'Claim your 3 free classes',
    subtext: "Drop your details and we'll sort your free classes — on us. Takes 20 seconds.",
    button_label: 'Get my 3 free classes',
    success_message:
      "You're in! 🎉 Check your phone and email — we'll be in touch with how to book your 3 free classes. See you in the studio.",
    consent_label:
      "I'd like to hear from UN1T Stillorgan about my free classes and offers by email, SMS and WhatsApp. I can opt out anytime.",
  },
  {
    id: 'free-class-pillars',
    type: 'pillars',
    items: [
      {
        number: '01',
        title: 'Coach-led, every session',
        body: "A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught.",
        photo_url:
          'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/21c12a60-dd94-4d51-802f-aac7a81f8cec.webp',
      },
      {
        number: '02',
        title: 'Race-ready conditioning',
        body: "Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes.",
        photo_url:
          'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/fc2a75a2-ac08-4ca0-be67-2fa68f793a45.webp',
      },
      {
        number: '03',
        title: 'A room that shows up',
        body: 'Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment.',
        photo_url:
          'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/2328da3c-ffef-4b2a-9967-f614cf1b60ba.webp',
      },
    ],
  },
  {
    id: 'free-class-stats',
    type: 'stats',
    items: [
      { number: '200+', label: 'Members training every week' },
      { number: '6', label: 'Race events hosted in 2025' },
      { number: '4.9', label: 'Average member rating' },
    ],
  },
  {
    id: 'free-class-testimonial',
    type: 'testimonial',
    quote:
      "I've been a member of UN1T Dublin since the day it opened and I've loved every single session since! The coaches are great fun but also really committed to ensuring all members are looked after — from getting the right weights to having their form on point. The community is really special, and I'm always leaving with a smile.",
    author: 'Simon Goldsmith — Joined 2022',
  },
]

export const metadata = {
  title: 'Your first 3 classes free — UN1T Stillorgan',
  description:
    'Coach-led strength & conditioning in Stillorgan, Dublin. Claim your first 3 classes free — no membership, no pressure.',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'Your first 3 classes free — UN1T Stillorgan',
    description:
      'Coach-led strength & conditioning in Stillorgan, Dublin. Claim your first 3 classes free — no membership, no pressure.',
    siteName: 'UN1T Dublin',
    type: 'website',
  },
}

export default async function FreeClassPage() {
  const logoUrl = await getLandingLogo('stillorgan', STILLORGAN_LANDING_LOGO)
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <SiteHeader
        logoUrl={logoUrl}
        logoAlt="UN1T Stillorgan"
        sticky
        ctaHref={CTA.href}
        ctaLabel={CTA.label}
      />
      {BLOCKS.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath="stillorgan"
          campaign="stillorgan-free-class"
          ctaHref={CTA.href}
          ctaLabel={CTA.label}
        />
      ))}
      <SiteFooter ctaHref={CTA.href} ctaLabel={CTA.label} />
    </div>
  )
}
