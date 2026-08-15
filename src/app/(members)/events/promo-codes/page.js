// /events/promo-codes — operator management of event checkout discount codes
// (EVENTS-PROMO.1). Lists the active location's codes and offers a create
// form + per-row activate/delete. The money-path (validation + redemption on
// the public register route) is untouched by this surface — this is admin CRUD
// only, backed by /api/promo-codes.
//
// Gated identically to the API it drives: Manager+ AND the `races` permission
// (a discount is a money lever, so it sits at the same level as the events
// surface it applies to). Non-managers with `races` can still see /events but
// not this page — they'd only get 403s from the CRUD API.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import PromoCodesManager from '@/components/PromoCodesManager'

export const dynamic = 'force-dynamic'

export default async function PromoCodesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Same gate as /api/promo-codes: Manager+ with the events (`races`) key.
  if (!MANAGER_ROLES.includes(user.role) || !hasPermission(user, 'races')) redirect('/')

  const activeLocationId = user.activeLocation?.id || null

  // Own-location events only for the picker + the Scope column's name map. A
  // promo code can only be tied to an event at THIS location (the POST route
  // rejects a cross-location event_id), so shared events owned elsewhere are
  // deliberately excluded — offering them would just produce a 400 on submit.
  let events = []
  if (activeLocationId) {
    const { data } = await createServerClient()
      .from('race_events')
      .select('id, name, race_date, kind, active')
      .eq('location_id', activeLocationId)
      .order('race_date', { ascending: false })
    events = data || []
  }

  return (
    <div className="p-8 max-w-5xl">
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-3">
        <ArrowLeft size={14} /> Back to Events
      </Link>
      <h2 className="text-2xl font-bold text-un1t-text">Promo codes</h2>
      <p className="text-sm text-un1t-subtle mt-1 mb-6">
        Discount codes customers can enter at event checkout. Tie a code to one event or leave it global (any event at this location).
        Codes are case-insensitive and stored uppercase.
      </p>

      <PromoCodesManager events={events} />
    </div>
  )
}
