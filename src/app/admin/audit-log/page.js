// /admin/audit-log — Master-only browser for the unified audit log.
//
// AUDIT-EXPAND.1: previously a viewer for assignment_change_log
// only; now backed by the audit_events table which spans auth,
// business, mutation, and assignment events. Filters at the top of
// the page slice by Category / Action / Actor / Affected user /
// Location / date range — all in one view.
//
// Server component: fetches the dropdown source data (active staff for
// the actor / target filters, locations for the location filter) so the
// client table doesn't have to do a second round-trip. The actual
// log read goes through /api/admin/audit-log so the same backend
// powers an eventual programmatic export.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import AuditLogTable from '@/components/AuditLogTable'

export const dynamic = 'force-dynamic'

export default async function AdminAuditLogPage() {
  // STUDIO-GROUP.1 — page-level master gate. /admin layout relaxed
  // so non-master users with Studio Management child permissions
  // can pass; audit log stays master-only at the page level.
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') redirect('/')

  const db = createServerClient()

  // Filter source data — small enough to load whole-cloth.
  const [staffRes, locsRes] = await Promise.all([
    db.from('profiles').select('id, full_name, email, role').eq('active', true).order('full_name'),
    db.from('locations').select('id, name').eq('active', true).eq('is_host_anchor', false).order('name'),
  ])

  return (
    <div className="p-8 max-w-7xl">
      <h2 className="text-2xl font-bold mb-1">Audit log</h2>
      <p className="text-sm text-un1t-subtle mb-8">
        Unified record of authentication events, high-value business
        actions, and assignment / role changes across the platform.
        Append-only — entries are never edited or deleted. Filter at the
        top to narrow by category, actor, target, location, or date; click
        any row to expand the full event payload. CSV export available for
        compliance and external review.
      </p>
      <AuditLogTable
        staff={staffRes.data || []}
        locations={locsRes.data || []}
      />
    </div>
  )
}
