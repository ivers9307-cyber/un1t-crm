// REPORT-ISSUE.2 — handler inbox for staff-reported issues at the active
// location.
//
// Read access: owner + master per the original design ("All owners at the
// studio"), PLUS anyone holding the grantable `issues_inbox` permission —
// HUBDOOR.1. This page used to gate on the roles alone, which made the
// registered key a no-op here while the ⌘K palette gated its Issues
// command ON that same key: granting it to a manager produced a command
// that redirected them straight back to '/'. The shared resolver in
// src/lib/issues-access.js is now the single definition, used by this page
// and by all six handler API routes, so the page, the palette, the
// approvals Issues tab and the permission UI finally agree.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { isIssueHandler } from '@/lib/issues-access'
import IssuesInbox from '@/components/issues/IssuesInbox'

export const dynamic = 'force-dynamic'

export default async function IssuesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isIssueHandler(user)) redirect('/')

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
