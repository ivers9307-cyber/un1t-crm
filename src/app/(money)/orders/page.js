// /orders — operator-facing list of every paid (or attempted)
// transaction across all sources (race signups, car deposits,
// future revenue streams). Manager+ at the user's active location;
// master sees all locations.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import OrdersTable from '@/components/OrdersTable'

export const dynamic = 'force-dynamic'

export default async function OrdersIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')
  // Per-location feature gate + per-user permission, mig 092 audit.
  if (!hasPermission(user, 'orders')) redirect('/')

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-un1t-text">Orders</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Every transaction across races, cars, and future revenue streams.
        </p>
      </header>
      <OrdersTable />
    </div>
  )
}
