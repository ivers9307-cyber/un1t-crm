// /admin/* — master-only home for platform-level tools.
//
// Distinct from /settings/* which is for per-location operator
// admin (locations, staff, integrations, etc.). Anything that
// crosses tenant/org boundaries lives here:
//   - /admin/matrix — locations × features grid + access overview
//   - (future)      audit log, API keys, tenant management
//
// The gate is a hard redirect to / for non-master callers. RLS at
// the data layer is the second line of defence — even if a non-
// master somehow reached an /admin/* page (impersonation flow gone
// wrong, route mistake), they'd see no data because most of what
// these pages render requires master-level visibility anyway.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // user.role flips per active location; profileRole is the canonical
  // global value. Master is platform-wide so we read from profileRole
  // (which is 'master') rather than the per-location role.
  if (user.profileRole !== 'master') redirect('/')

  return children
}
