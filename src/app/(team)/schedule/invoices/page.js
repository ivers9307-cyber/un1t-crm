// /schedule/invoices — contractor invoice submissions + owner/master review.
//
// Single page, role-aware: contractors see their own list + a submit
// form; owners/masters see a review queue scoped to their locations.
// Masters see everything. The InvoicesManager component handles
// rendering both views.

import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import ScheduleTabs from '@/components/ScheduleTabs'
import InvoicesManager from '@/components/InvoicesManager'

export const dynamic = 'force-dynamic'

export default async function InvoicesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return (
    <div className="p-8">
      {/* SCHED.9 — the Schedule tab strip now follows onto every sibling
          page, not just the root. */}
      <ScheduleTabs user={user} />
      <InvoicesManager user={user} />
    </div>
  )
}
