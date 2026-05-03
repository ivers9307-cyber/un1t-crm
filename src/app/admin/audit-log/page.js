// /admin/audit-log — Master-only browser for assignment_change_log.
//
// Server component: fetches the dropdown source data (active staff for
// the actor / target filters, locations for the location filter) so the
// client table doesn't have to do a second round-trip. The actual
// log read goes through /api/admin/audit-log so the same backend
// powers an eventual programmatic export.

import { createServerClient } from '@/lib/supabase'
import AuditLogTable from '@/components/AuditLogTable'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function AdminAuditLogPage() {
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
