// /orders/[id] — operator drill-in for a single order. Shows the
// order details, the retry chain (orders linked to this one), the
// event timeline, and a summary of the source row (race or car).

import { redirect, notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtAnyLocation, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import OrderDetail from '@/components/OrderDetail'

export const dynamic = 'force-dynamic'

export default async function OrderDetailPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // PAGEGATES.1 — the coarse pre-checks GET /api/orders/[id] makes, then its
  // real decision at the ORDER's location (membership 404, MANAGER_ROLES and
  // `orders` there), never the active studio's role or permission.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) redirect('/')
  if (!hasPermissionAtAnyLocation(user, 'orders')) redirect('/')

  const db = createServerClient()
  const { data: order, error } = await db
    .from('orders')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (error || !order) notFound()
  if (assertLocationAccess(user, order.location_id)) notFound()
  if (!hasRoleAtLocation(user, order.location_id, MANAGER_ROLES)) redirect('/')
  if (!hasPermissionForLocation(user, order.location_id, 'orders')) redirect('/')

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <OrderDetail orderId={params.id} />
    </div>
  )
}
