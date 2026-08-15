// SETTINGS.2g Task 2 — shared /settings layout. Chrome ONLY: a slim
// breadcrumb header rendered above every settings page (the single
// back-link style, replacing ~10 hand-rolled copies — see Task 2 step 3
// commit notes for the per-page keep/remove list). Auth-gated (signed-in
// only), deliberately NOT permission-gated — see the comment below.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import SettingsBreadcrumb from '@/components/settings/SettingsBreadcrumb'

export const dynamic = 'force-dynamic'

export default async function SettingsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // NO permission gate at this level. VERIFIED before shipping this file
  // by reading the server-side gate of every /settings/* sub-page (Task 2
  // step 2) — the family is genuinely heterogeneous, with no common floor
  // beyond "signed in":
  //   - hasPermission(user, 'settings'): staff, notifications,
  //     integration-health, status-page, and this index page itself.
  //   - MANAGER_ROLES (master/owner/manager/head_coach): class-categories,
  //     holidays, shifts, customer-agent (+ analytics/requests), scoring.
  //   - ADMIN_ROLES (master/owner/manager): usage (view tier), hosts
  //     (+ hosts/[id]).
  //   - hardcoded owner/master (narrower than MANAGER_ROLES, no
  //     `settings` key involved): email-domain, api-keys, billing,
  //     integrations-hub.
  //   - hardcoded master/owner (excludes manager + head_coach, so
  //     narrower again): locations/[id], staff/new, staff/[id].
  //   - master only: locations/new; impersonate (the real underlying
  //     master, even mid-impersonation).
  //   - a single permission key narrower than 'settings': landing-page
  //     ('landing_page').
  //   - open to any authenticated user, with an org-scoped empty shell
  //     otherwise: integrations/zoom-contacts.
  // A layout-level `settings` gate would 403 every MANAGER_ROLES /
  // ADMIN_ROLES / hardcoded-role page for a legitimate holder of one of
  // those narrower grants who doesn't happen to also hold `settings` (a
  // head_coach with no `settings` permission still needs
  // class-categories, for example) — locking out real users to save one
  // check. Each sub-page already enforces its own real gate; this layout
  // supplies chrome only, and relies on those per-page gates for
  // enforcement, same as before this layout existed.
  return (
    <>
      <SettingsBreadcrumb />
      {children}
    </>
  )
}
