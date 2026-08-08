// /offers layout (OFFERS.7) — loads the sale's display faces (self-hosted by
// next/font, no external requests) and the page chrome shared by the landing
// and product pages. Public marketing-host surface: '/offers' is allowlisted
// in src/lib/brands.js + src/proxy.js + AppShell PUBLIC_PATHS (all three, or
// a logged-out visitor bounces — the /free-class lesson).
import { Archivo, Archivo_Black } from 'next/font/google'
import './offers.css'

const archivo = Archivo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-archivo' })
const archivoBlack = Archivo_Black({ subsets: ['latin'], weight: '400', variable: '--font-archivo-black' })

export const metadata = {
  title: 'Lock In Your Membership — UN1T Stillorgan',
  robots: { index: false, follow: false },
}

export default function OffersLayout({ children }) {
  return (
    <div className={`ofr ${archivo.variable} ${archivoBlack.variable}`}>
      <div className="ofr-frame">
        {children}
        <footer style={{ padding: '40px 32px', color: '#666', fontSize: 12, letterSpacing: '.12em', borderTop: '1px solid var(--ofr-line)' }}>
          UN1T STILLORGAN · SALE ENDS MONDAY 11 AUGUST, 23:59 · CHAMP CHAMP FITNESS LIMITED, DUBLIN, IRELAND
        </footer>
      </div>
    </div>
  )
}
