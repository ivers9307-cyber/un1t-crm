// /welcome/preview — DEV-ONLY design harness for the landing pages.
//
// Renders the exact public-page shell (SiteHeader → blocks →
// SiteFooter, reveals armed) from an in-repo fixture instead of the
// database, so landing-page design work can be iterated and
// screenshot locally without Supabase credentials. The fixtures are
// snapshots of the real production `landing_page_settings.blocks`
// (2026-06-11) — image/video URLs point at the public storage bucket
// so the preview shows the operator's actual media.
//
// `?p=stillorgan` (default) | `?p=hatch-street` picks the studio.
// Hard 404 outside development — this never ships content to prod.

import { notFound } from 'next/navigation'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import { primaryCta } from '@/lib/landing-page-blocks'

export const dynamic = 'force-dynamic'

const STORAGE = 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page'
const LOGO_URL = `${STORAGE}/a0000000-0000-0000-0000-000000000001/de12ffbe-22db-4c34-b307-8983488ffd96.png`

const PILLARS_STILLORGAN = [
  { number: '01', title: 'Coach-led, every session', body: "A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught.", photo_url: `${STORAGE}/a0000000-0000-0000-0000-000000000001/21c12a60-dd94-4d51-802f-aac7a81f8cec.webp` },
  { number: '02', title: 'Race-ready conditioning', body: "Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes.", photo_url: `${STORAGE}/a0000000-0000-0000-0000-000000000001/fc2a75a2-ac08-4ca0-be67-2fa68f793a45.webp` },
  { number: '03', title: 'A room that shows up', body: 'Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment.', photo_url: `${STORAGE}/a0000000-0000-0000-0000-000000000001/2328da3c-ffef-4b2a-9967-f614cf1b60ba.webp` },
]

const FIXTURES = {
  stillorgan: [
    { id: 'fx-hero', type: 'hero', eyebrow: 'Stillorgan, Dublin', headline: 'ACCOUNTABILITY, PERFORMANCE, RESULTS', subhead: '', subtext: 'Coach-led strength & conditioning, built for everybody. \nBook a free 30-minute consultation below.', image_url: null, video_url: null },
    { id: 'fx-booking', type: 'booking', slug: 'free-un1t-consultation' },
    { id: 'fx-pillars', type: 'pillars', items: PILLARS_STILLORGAN },
    { id: 'fx-stats', type: 'stats', items: [
      { number: '200+', label: 'Members training every week' },
      { number: '6', label: 'Race events hosted in 2025' },
      { number: '4.9', label: 'Average member rating' },
    ] },
    { id: 'fx-testimonial', type: 'testimonial', author: 'Simon Goldsmith - Joined 2022', quote: 'I’ve been a member of UN1T Dublin since the day it opened and I’ve loved every single session since! It’s great to see a new gym opening in such a great location with loads of parking - not to mention how slick the studio is. The team in UN1T Dublin are a really good bunch too- always greeting members with a smile and the coaches are great fun but also really committed to ensuring all members are looked after from getting the right weights to having their form on point! It’s been great to see so many new members joining week after week - it brings and extra level of community to the training - we all love a little healthy competition. Only open a couple of months and seeing great things, I’m excited to see what is to come!! Well done UN1T Dublin' },
  ],
  'hatch-street': [
    { id: 'fx-hero', type: 'hero', eyebrow: 'Hatch Street, Dublin', headline: 'UN1T OPENS 2nd STUDIO', subhead: 'STRENGTH AND CONDITIONING TRAINING IN HATCH STREET', subtext: 'Boutique gym in the heart of Dublin city, a stone’s throw from the Harcourt Street Luas stop.', image_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg`, video_url: null },
    { id: 'fx-lead', type: 'lead_form', heading: 'Get Early Access', subtext: 'Be first through the doors at UN1T Hatch Street. Leave your details and we’ll be in touch with founding-member offers before we open.', button_label: 'Join the waitlist', success_message: "You're on the list — we'll be in touch soon.", consent_label: 'I’d like to hear from UN1T about the Hatch Street launch and offers by email, SMS and WhatsApp. I can opt out anytime.', tag: 'hatch-founding-member', lead_source: 'hatch_launch' },
    { id: 'fx-videos', type: 'video_testimonials', title: 'Hear from our members', items: [
      { name: '', video_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/bd3d8257-8be3-465b-9bf9-86ea5b12f60c.mp4`, poster_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/26368e23-018a-443b-8409-8416054272e0.jpg` },
      { name: '', video_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/388b4d1c-ed49-4d46-8d27-c4f8388122b7.mp4`, poster_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/1a26306b-1a20-4099-9c6b-143700cad1ad.jpg` },
      { name: '', video_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/54f0460e-9ed6-45c7-8a79-1f6b18d19186.mp4`, poster_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/dfb68ec4-b084-4aa9-ab40-1a8728b4d0f8.jpg` },
    ] },
    { id: 'fx-pillars', type: 'pillars', items: [
      { ...PILLARS_STILLORGAN[0], photo_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3ba605f4-0446-4504-847e-9c10a2e1835d.jpg` },
      { ...PILLARS_STILLORGAN[1], photo_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/1c93feae-2f9b-41af-91b9-bcb9ef250fe8.jpg` },
      { ...PILLARS_STILLORGAN[2], photo_url: `${STORAGE}/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/cb7cb5db-c1c0-43ba-be09-41eb81c020c5.jpg` },
    ] },
    { id: 'fx-stats', type: 'stats', items: [
      { number: '7500+ ', label: '5 Star Ratings' },
      { number: '8', label: 'Race events hosted Monthly' },
      { number: '4.9 ⭐', label: 'Average member rating' },
    ] },
    { id: 'fx-testimonial', type: 'testimonial', author: 'Nikki M', quote: 'I’ve been going to UN1T since the day it opened and I haven’t looked back. It’s an amazing gym with incredible coaches who know when to push you, and know when you’re just there to clear the head after a busy day. It’s a brilliant mix of strength and conditioning and I’ve definitely seen a massive improvement in my strength and fitness. The community they have built there is really special with a really great group of people and I’m always leaving with a smile. ❤️' },
  ],
}

export default async function LandingPreviewPage(props) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const searchParams = await props.searchParams
  const key = searchParams?.p === 'hatch-street' ? 'hatch-street' : 'stillorgan'
  const blocks = FIXTURES[key]
  const cta = primaryCta(blocks)

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <RevealManager />
      <SiteHeader
        logoUrl={LOGO_URL}
        logoAlt="UN1T Dublin"
        logoWidthPx={200}
        sticky
        ctaHref={cta?.href || null}
        ctaLabel={cta?.label}
      />
      {blocks.map((block) => (
        <BlockRenderer
          key={block.id}
          block={block}
          publicPath={key}
          reviewsData={null}
          ctaHref={cta?.href || null}
          ctaLabel={cta?.label}
        />
      ))}
      <SiteFooter ctaHref={cta?.href || '#book'} ctaLabel={cta?.label || 'Book a free consult'} />
    </div>
  )
}
