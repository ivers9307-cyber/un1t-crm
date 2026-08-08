// /offer-sales — staff fulfilment queue for weekend-sale purchases
// (OFFERS.6). The Approvals "Offer sales" tab deep-links here. Shows paid,
// unfulfilled purchases for the active location with a Mark-fulfilled
// action (set the member up in Glofox FIRST, then mark), plus the last few
// fulfilled ones for reassurance.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import OfferSalesList from '@/components/OfferSalesList'

export const dynamic = 'force-dynamic'

export default async function OfferSalesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/offer-sales')
  if (!hasPermission(user, 'approvals_offer_purchases')) redirect('/dashboard')

  const activeId = user.activeLocation?.id
  const db = createServerClient()
  const { data } = activeId
    ? await db
        .from('offer_purchases')
        .select(`
          id, buyer_name, buyer_email, buyer_phone, amount_cents, currency,
          state, paid_at, fulfilled_at, contact_id,
          offer:offer_id ( id, name, bonus_headline )
        `)
        .eq('location_id', activeId)
        .eq('state', 'paid')
        .order('paid_at', { ascending: false })
        .limit(100)
    : { data: [] }

  const rows = data || []
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Offer sales</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Paid sale purchases. Set the member up in Glofox first, then mark the sale fulfilled.
        </p>
      </header>
      <OfferSalesList
        pending={rows.filter((r) => !r.fulfilled_at)}
        fulfilled={rows.filter((r) => r.fulfilled_at).slice(0, 10)}
      />
    </div>
  )
}
