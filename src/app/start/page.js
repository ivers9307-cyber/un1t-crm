// /start — public Meta-ad booking wizard (Stillorgan). The StartFunnel client
// island now sits as a frosted card over a full-bleed hero image, matching the
// welcome-page hero treatment (Ken Burns push-in + bottom-weighted scrim +
// film grain; lp-* classes from globals.css). Stillorgan's own landing has no
// hero image, so we use Hatch Street's training shot — swap HERO_IMAGE to
// change it. Allowlisted in brands.js (un1t-marketing) + proxy.js + AppShell.
// noindex: a paid funnel shouldn't compete in organic search.

import StartFunnel from '@/components/StartFunnel'

const STILLORGAN_LOGO =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/de12ffbe-22db-4c34-b307-8983488ffd96.png'

const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'

export const metadata = {
  title: 'Book your free start — UN1T Stillorgan',
  description: 'Book a free consultation or first class at UN1T Stillorgan — coach-led strength & conditioning.',
  robots: { index: false, follow: false },
}

export default function StartPage() {
  return (
    <main className="relative min-h-screen flex flex-col overflow-hidden bg-black text-white antialiased lp-grain">
      {/* Hero backdrop: slow Ken Burns push-in + a bottom-weighted scrim so the
          frosted funnel card always carries over the image. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${HERO_IMAGE})` }} />
      </div>
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }}
      />

      <header className="absolute inset-x-0 top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <img src={STILLORGAN_LOGO} alt="UN1T Stillorgan" width={150} className="h-8 w-auto object-contain" />
        </div>
      </header>

      <div className="relative z-10 flex-1 flex items-center justify-center px-5 pt-24 pb-14">
        <StartFunnel />
      </div>
    </main>
  )
}
