// /cars layout — header + 3-segment control matching the Dashboard
// pattern. Permission gate honoured for every role; Sidebar already
// filters the entry, but a direct-URL hit also gets bounced if the
// permission is off.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import CarTabs from '@/components/cars/CarTabs'

export const dynamic = 'force-dynamic'

export default async function CarsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'car_processing')) redirect('/')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-un1t-white mb-1">Car Processing</h1>
      <p className="text-sm text-un1t-light mb-5">
        {user.activeLocation?.name || 'Tesla import workflow'}
      </p>
      <CarTabs />
      {children}
    </div>
  )
}
