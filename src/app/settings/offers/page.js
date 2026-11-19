import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { hasPermission } from '@/lib/permissions'
import OffersEditorCard from '@/components/settings/OffersEditorCard'

export const dynamic = 'force-dynamic'

// OFFERSEDIT.1 — the studio's sale offers (public.sale_offers), until now set
// up only with SQL. Whoever sees Offer sales can read; owners and masters edit
// (the card asks the API).
export default async function OffersSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'approvals_offer_purchases')) redirect('/')
  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/settings')

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">Offers</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        What the studio sells on its offers page: packs, memberships and gift cards, with their price, dates and stock.
      </p>
      <OffersEditorCard locationId={locationId} />
    </div>
  )
}
