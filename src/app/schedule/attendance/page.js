// /schedule/attendance — owner/manager/master-only attendance report.
//
// Auto-stamped from UniFi Access door unlocks (mig 120 + the
// /api/webhooks/unifi-access receiver). This page is a read-only
// monitoring view; not visible to staff (gated by attendance_reports
// permission, default off for staff + head_coach roles).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import AttendanceReportClient from '@/components/AttendanceReportClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function AttendanceReportPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'attendance_reports')) redirect('/')

  return (
    <div className="p-8 max-w-7xl">
      <h2 className="text-2xl font-bold mb-1">Attendance</h2>
      <p className="text-sm text-un1t-light mb-8 max-w-3xl">
        Auto-stamped from UniFi Access door unlocks. On-time means the
        first card-tap was within 60 seconds of the scheduled start;
        anything later is late. Pending means the shift is still in
        progress and we haven&apos;t seen an arrival yet. No-show means
        the shift ended with no arrival recorded.
      </p>
      <AttendanceReportClient activeLocationName={user.activeLocation?.name || ''} />
    </div>
  )
}
