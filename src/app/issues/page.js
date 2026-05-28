// REPORT-ISSUE.2 — owner / master inbox for staff-reported issues
// at the active location.
//
// Read access scoped to owner + master per the design ("All owners
// at the studio") — page-level redirect for other roles.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import IssuesInbox from '@/components/issues/IssuesInbox'

export const dynamic = 'force-dynamic'

function isHandler(user) {
  if (!user) return false
  if (user.role === 'master' || user.isMaster) return true
  return user.role === 'owner'
}

export default async function IssuesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isHandler(user)) redirect('/')

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <h2 className="text-2xl font-bold mb-1">Issues</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Problems reported by staff at the studio. Pick one up, mark it resolved when fixed, and the original reporter gets pinged.
      </p>
      <IssuesInbox />
    </div>
  )
}
