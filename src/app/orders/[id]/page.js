// /orders/[id] — operator drill-in for a single order. Shows the
// order details, the retry chain (orders linked to this one), the
// event timeline, and a summary of the source row (race or car).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import OrderDetail from '@/components/OrderDetail'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function OrderDetailPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <OrderDetail orderId={params.id} />
    </div>
  )
}
