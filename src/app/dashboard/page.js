// /dashboard — entry. Redirects to the user's preferred dashboard if
// they've set one (permissions.landing_preference, editable in
// /account); otherwise to the most-aggregated sub-view they have
// permission for. If none, a "no dashboards available" stub
// rendered inside the dashboard layout (which itself sits inside
// the root AppShell).

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { resolveLandingPreference, LANDING_PREFERENCE_TARGETS } from '@shared/permissions'

export const dynamic = 'force-dynamic'

export default async function DashboardIndex() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // 1. User-set landing preference (no migration — top-level key on
  // profiles.permissions JSONB). If the user picked Today, Studio,
  // or Business in /account, honour it — provided they still have
  // permission for that dashboard at the active location. If the
  // permission was revoked after they set the preference, fall
  // through to the smart-default chain below instead of bouncing
  // them or 403'ing. 'auto' (and unset) also fall through.
  const pref = resolveLandingPreference(user)
  if (pref !== 'auto') {
    const target = LANDING_PREFERENCE_TARGETS[pref]
    if (target && hasPermission(user, target.perm)) {
      redirect(target.route)
    }
  }

  // 2. Smart default — most-aggregated dashboard the user has access
  // to. Owner with all three on lands on Business; manager on
  // Studio; staff on Today. An owner who toggled them all off ends
  // up on the empty-state below.
  if (hasPermission(user, 'dashboard_business')) redirect('/dashboard/business')
  if (hasPermission(user, 'dashboard_studio'))   redirect('/dashboard/studio')
  if (hasPermission(user, 'dashboard_personal')) redirect('/dashboard/today')

  // Falls back to the layout's chrome (header + segmented control)
  // with this empty-state message in the body.
  return (
    <p className="text-sm text-un1t-light">
      You don&apos;t have access to any dashboards yet. Ask an admin to enable
      Today, Studio, or Business in your profile.
    </p>
  )
}
