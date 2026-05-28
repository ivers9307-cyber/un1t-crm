// CHECKLIST.1 — admin page for managing checklist templates.
// Master + owner at the active location can land here. Below the
// header the page renders a 7 (day) × 4 (role) grid showing
// "X items" for each cell that has a template, or an "Add" CTA
// for empty cells. Click into a cell to edit the items inline.
//
// PR 2 will use these templates to generate per-(profile, date)
// instances when a coach has a shift assignment matching the
// triple (location, role, day_of_week).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ChecklistTemplatesEditor from '@/components/admin/ChecklistTemplatesEditor'

export const dynamic = 'force-dynamic'

function canEnter(user) {
  if (!user) return false
  // Master always lands. Owners + anyone with studio_management get
  // access; the API enforces write-permission (master + owner).
  if (user.role === 'master' || user.isMaster) return true
  if (user.role === 'owner') return true
  return hasPermission(user, 'studio_management')
}

export default async function ChecklistsAdminPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!canEnter(user)) redirect('/admin')

  return (
    <div className="p-6 md:p-8 max-w-6xl">
      <h2 className="text-2xl font-bold mb-1">Checklists</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-3xl">
        Define what each role needs to tick off on each day of the week. Coaches see their matching checklist on their phone when they have a shift; head coaches and owners get notified when items are left undone.
      </p>
      <ChecklistTemplatesEditor canEdit={user.role === 'master' || user.isMaster || user.role === 'owner'} />
    </div>
  )
}
