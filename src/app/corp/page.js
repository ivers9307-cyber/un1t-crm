// /corp — CORPPROMO.1: the live corporate promo (today: 3 free classes at
// Hatch Street). Body in ./corp-page.jsx. Public: on the proxy, AppShell,
// un1t-marketing brand and tenant-domain allowlists
// (src/public-compliance-paths.test.jsx). noindex.
import CorpPage, { corpMetadata } from './corp-page'

export const dynamic = 'force-dynamic'
export const metadata = corpMetadata

export default function Page() {
  return <CorpPage />
}
