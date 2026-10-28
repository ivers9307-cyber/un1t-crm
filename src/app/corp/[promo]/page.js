// /corp/<promo> — CORPPROMO.1: one corporate promo by its registry key
// (src/lib/corp-promos.js). An unknown or switched-off key shows "not
// available right now". Body in ../corp-page.jsx.
import CorpPage, { corpMetadata } from '../corp-page'

export const dynamic = 'force-dynamic'
export const metadata = corpMetadata

export default async function Page(props) {
  const { promo } = await props.params
  return <CorpPage promoKey={typeof promo === 'string' ? promo : ''} />
}
