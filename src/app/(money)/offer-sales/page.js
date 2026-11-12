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
import { zoneOfLocation } from '@/lib/location-time'
import { logError } from '@/lib/log'

export const dynamic = 'force-dynamic'

const PURCHASE_COLUMNS = `
  id, buyer_name, buyer_email, buyer_phone, amount_cents, currency,
  state, paid_at, fulfilled_at, contact_id,
  payment_provider, origin, un1t_user_id, last_error,
  offer:offer_id ( id, name, bonus_headline )
`
const PAGE_SIZE = 1000
// A runaway guard, never reached by a real sale: 10,000 unfulfilled sales.
const PENDING_MAX_PAGES = 10

export default async function OfferSalesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login?redirect=/offer-sales')
  if (!hasPermission(user, 'approvals_offer_purchases')) redirect('/dashboard')

  const activeId = user.activeLocation?.id
  const db = createServerClient()

  // BLACKFRIDAY.9 — two reads, both inside the active location. Pending is
  // every paid, unfulfilled sale, OLDEST first (the queue's order), paged past
  // PostgREST's 1,000-row cap; it used to be the newest 100 paid rows split in
  // two, so the oldest pending sales vanished once 100 had been paid.
  let pending = []
  let fulfilled = []
  let pendingTruncated = false
  let loadFailed = false
  if (activeId) {
    for (let page = 0; ; page++) {
      if (page >= PENDING_MAX_PAGES) { pendingTruncated = true; break }
      const from = page * PAGE_SIZE
      const { data, error } = await db
        .from('offer_purchases')
        .select(PURCHASE_COLUMNS)
        .eq('location_id', activeId)
        .eq('state', 'paid')
        .is('fulfilled_at', null)
        .order('paid_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (error) {
        logError('offers', 'offer sales pending unreadable', { locationId: activeId, code: error.code ?? null })
        loadFailed = true
        break
      }
      pending = pending.concat(data || [])
      if (!data || data.length < PAGE_SIZE) break
    }

    const { data: done, error: doneErr } = await db
      .from('offer_purchases')
      .select(PURCHASE_COLUMNS)
      .eq('location_id', activeId)
      .eq('state', 'paid')
      .not('fulfilled_at', 'is', null)
      .order('fulfilled_at', { ascending: false })
      .limit(10)
    if (doneErr) {
      logError('offers', 'offer sales fulfilled unreadable', { locationId: activeId, code: doneErr.code ?? null })
      loadFailed = true
    } else {
      fulfilled = done || []
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Offer sales</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Paid Black Friday and sale purchases. Set the member up, add the bonus, then mark the sale fulfilled.
        </p>
      </header>
      {loadFailed && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">
          Some sales could not be loaded. Refresh the page; if it keeps happening, tell the team.
        </p>
      )}
      {pendingTruncated && (
        <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          Showing the oldest {pending.length.toLocaleString('en-IE')} sales to fulfil. Mark some fulfilled to see the rest.
        </p>
      )}
      <OfferSalesList
        pending={pending}
        fulfilled={fulfilled}
        timezone={zoneOfLocation(user.activeLocation)}
      />
    </div>
  )
}
