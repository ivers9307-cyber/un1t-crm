// /schedule/attendance — owner/manager/master-only attendance report.
//
// Auto-stamped from the mobile geofence check-in (mig 463 + the
// /api/attendance/geofence-checkin route), plus manual entry. This page
// is a read-only monitoring view; not visible to staff (gated by
// attendance_reports permission, default off for staff + head_coach).
// Historical rows may carry source='unifi_access'/'protect' from the
// UniFi pipelines removed 2026-07-31 — see docs/staff-attendance.md.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ScheduleTabs from '@/components/ScheduleTabs'
import AttendanceReportClient from '@/components/AttendanceReportClient'

export const dynamic = 'force-dynamic'

export default async function AttendanceReportPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'attendance_reports')) redirect('/')

  return (
    <div className="p-8 max-w-7xl">
      {/* SCHED.9 — Schedule tab strip follows onto every sibling page.
          This URL itself is unchanged (live cron-email consumers with no
          in-repo link — see the header comment above). */}
      <ScheduleTabs user={user} />
      <h2 className="text-2xl font-bold mb-1">Attendance</h2>
      <p className="text-sm text-un1t-subtle mb-8 max-w-3xl">
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
