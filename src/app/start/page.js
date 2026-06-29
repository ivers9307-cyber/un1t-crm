// /start — public Meta-ad booking wizard (Stillorgan). Renders the
// StartFunnel client island inside the shared dark landing chrome.
// Allowlisted in brands.js (un1t-marketing) + proxy.js + AppShell.
// noindex: a paid funnel shouldn't compete in organic search.

import StartFunnel from '@/components/StartFunnel'

const STILLORGAN_LOGO =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/a0000000-0000-0000-0000-000000000001/de12ffbe-22db-4c34-b307-8983488ffd96.png'

export const metadata = {
  title: 'Book your free start — UN1T Stillorgan',
  description: 'Book a free consultation at UN1T Stillorgan — coach-led strength & conditioning.',
  robots: { index: false, follow: false },
}

export default function StartPage() {
  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <header className="border-b border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <img src={STILLORGAN_LOGO} alt="UN1T Stillorgan" width={150} className="h-8 w-auto" />
        </div>
      </header>
      <StartFunnel />
    </div>
  )
}
