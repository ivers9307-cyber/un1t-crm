// /cars layout — header + 3-segment control matching the Dashboard
// pattern. Permission gate honoured for every role; Sidebar already
// filters the entry, but a direct-URL hit also gets bounced if the
// permission is off.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionAtAnyLocation } from '@/lib/permissions'
import CarTabs from '@/components/cars/CarTabs'
import { staffTabMetadata } from '@/lib/staff-tab-title'

export const dynamic = 'force-dynamic'

// TABTITLE.1 — the tab names the ACTIVE studio for every page under this
// layout (see src/lib/staff-tab-title.js). This is the OUTERMOST staff layout
// of its subtree: a layout nested under it must NOT export this again, or the
// tab reads "Studio · Studio".
export async function generateMetadata() {
  return staffTabMetadata()
}

export default async function CarsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // GATES-2 — coarse: `car_processing` at SOME studio. /cars/[id] judges the
  // car's studio and the list pages (active, completed, reports) the active
  // one; judging the active studio here bounced a car at another studio.
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) redirect('/')

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Car Processing</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {user.activeLocation?.name || 'Tesla import workflow'}
      </p>
      <CarTabs />
      {children}
    </div>
  )
}
