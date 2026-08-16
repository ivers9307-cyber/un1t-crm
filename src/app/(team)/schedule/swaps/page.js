import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import SwapRequestsManager from '@/components/SwapRequestsManager'

export const dynamic = 'force-dynamic'

export default async function SwapRequestsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="p-8">
      {/* SCHED.9 — the other convergence target for the old inline
          "Approvals" tab (see ScheduleTabs.jsx). SwapRequestsManager keeps
          its own internal "Back to Schedule" link — harmless overlap with
          the Schedule tab now above it, left as-is to limit the diff. */}
      <ScheduleTabs user={user} />
      <SwapRequestsManager user={user} />
    </div>
  )
}
