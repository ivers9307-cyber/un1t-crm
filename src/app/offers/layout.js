// /offers layout (OFFERS.7) — loads the sale's display faces (self-hosted by
// next/font, no external requests) and the page chrome shared by the landing
// and product pages. Public marketing-host surface: '/offers' is allowlisted
// in src/lib/brands.js + src/proxy.js + AppShell PUBLIC_PATHS (all three, or
// a logged-out visitor bounces — the /free-class lesson).
import { Archivo, Archivo_Black } from 'next/font/google'
import { createServerClient } from '@/lib/supabase'
import { formatSaleDeadline } from '@/lib/sale-offers'
import './offers.css'

const archivo = Archivo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-archivo' })
const archivoBlack = Archivo_Black({ subsets: ['latin'], weight: '400', variable: '--font-archivo-black' })

export const metadata = {
  title: 'Lock In Your Membership — UN1T Stillorgan',
  robots: { index: false, follow: false },
}

export default async function OffersLayout({ children }) {
  // Deadline is DERIVED from the live sale window, never hard-coded — see
  // formatSaleDeadline(). A literal date here disagreed with the countdown
  // the moment the operator moved ends_at in SQL.
  const db = createServerClient()
  // Only DATED offers can produce a deadline line. Gift cards carry
  // ends_at NULL, and Postgres sorts NULLs first on DESC — without this
  // filter a live gift card would win the ordering and blank out a real
  // sale's deadline in the footer.
  const { data } = await db
    .from('sale_offers')
    .select('ends_at')
    .eq('active', true)
    .not('ends_at', 'is', null)
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const deadline = formatSaleDeadline(data?.ends_at)

  return (
    <div className={`ofr ${archivo.variable} ${archivoBlack.variable}`}>
      <div className="ofr-frame">
        {children}
        <footer style={{ padding: '40px 32px', color: '#666', fontSize: 12, letterSpacing: '.12em', borderTop: '1px solid var(--ofr-line)' }}>
          UN1T STILLORGAN{deadline ? ` · SALE ENDS ${deadline}` : ''} · CHAMP CHAMP FITNESS LIMITED, DUBLIN, IRELAND
        </footer>
      </div>
    </div>
  )
}
