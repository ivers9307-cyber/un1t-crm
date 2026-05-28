// /admin/marketing-import — bulk import of marketing preferences
// from external platforms (Mailchimp / Klaviyo / ActiveCampaign /
// any CSV export with email + per-channel boolean columns).
//
// Master-only. Belt-and-braces gate even though /admin/layout.js
// already enforces master at the route level.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import MarketingPreferencesImportPanel from '@/components/MarketingPreferencesImportPanel'

export const dynamic = 'force-dynamic'

export default async function MarketingImportPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // STUDIO-GROUP.1 — was master-only via isMaster flag; now uses
  // the `preferences_import` permission. Default still master-only
  // via role defaults; operators can grant per user from StaffForm.
  if (!hasPermission(user, 'preferences_import')) redirect('/')

  return (
    <div className="p-8 max-w-5xl">
      <h2 className="text-2xl font-bold mb-1">Marketing preferences import</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Migrate consent state from another platform (Mailchimp, Klaviyo, ActiveCampaign,
        anything that exports a CSV). Preview the change plan before committing — only
        contacts whose preferences actually need to change will be touched, and ClassPass
        contacts are skipped automatically per the deliverability rule.
      </p>
      <MarketingPreferencesImportPanel />
    </div>
  )
}
