// /admin/audit-log — Master-only browser for assignment_change_log.
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
    db.from('locations').select('id, name').eq('active', true).order('name'),
  ])

  return (
    <div className="p-8 max-w-7xl">
      <h2 className="text-2xl font-bold mb-1">Audit log</h2>
      <p className="text-sm text-un1t-light mb-8">
        Every assignment change made through the admin matrix v2 (and any future route that calls
        the assignment-changes audit writer). Append-only — entries are never deleted or edited.
        CSV export available for compliance and external review.
      </p>
      <AuditLogTable
        staff={staffRes.data || []}
        locations={locsRes.data || []}
      />
    </div>
  )
}
