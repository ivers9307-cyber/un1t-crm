// /offers layout (OFFERS.7) — loads the sale's display faces (self-hosted by
// next/font, no external requests) and the page frame shared by the studio
// picker, the storefronts and the product pages. Public marketing-host
// surface: '/offers' is allowlisted in src/proxy.js publicPaths, AppShell
// PUBLIC_PATHS, the un1t-marketing allowedPaths in src/lib/brands.js and
// DB_BRAND_DEFAULTS in src/lib/tenant-domains-edge.js (nested paths match
// by prefix).
//
// BLACKFRIDAY.3 — this layout has no studio, so it reads nothing: the tab
// title and the footer (studio, deadline, legal line) live in
// src/app/offers/[studio]/layout.js, and the picker sets its own title.
import { Archivo, Archivo_Black } from 'next/font/google'
import './offers.css'

const archivo = Archivo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-archivo' })
const archivoBlack = Archivo_Black({ subsets: ['latin'], weight: '400', variable: '--font-archivo-black' })

export default function OffersLayout({ children }) {
  return (
    <div className={`ofr ${archivo.variable} ${archivoBlack.variable}`}>
      <div className="ofr-frame">
        {children}
      </div>
    </div>
  )
}
