// USAGE.1 — /admin/app-usage: who uses the phone app and web CRM, when,
// which features, for how long and how many times a day. Platform console
// (PlatformShell), master only. Design:
// docs/superpowers/specs/2026-10-26-app-usage-design.md.
//
// A thin server gate around AppUsageReport, which reads everything through
// /api/admin/app-usage* (the same master gate, enforced again there).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { isUsageReportViewer } from '@/lib/app-usage/queries'
import AppUsageReport from '@/components/admin/AppUsageReport'

export const dynamic = 'force-dynamic'

export default async function AppUsagePage() {
  const user = await getCurrentUser()
  if (!isUsageReportViewer(user)) redirect('/')

  return (
    <div className="p-6 md:p-8 max-w-6xl">
      <h2 className="text-2xl font-bold mb-1">App usage</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Which staff use the phone app and the CRM website, when, which features
        and for how long. Masters and &ldquo;view as&rdquo; sessions are never
        recorded. Screen-by-screen detail is kept 90 days; daily totals 12 months.
      </p>
      <AppUsageReport />
    </div>
  )
}
