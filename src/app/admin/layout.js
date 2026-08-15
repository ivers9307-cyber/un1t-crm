// /admin/* — historically master-only home for platform-level tools.
//
// Distinct from /settings/* which is for per-location operator
// admin (locations, staff, integrations, etc.). The hard-master-only
// gate was relaxed by STUDIO-GROUP.1 (May 2026) so that the Studio
// Management children living under /admin/* (originally contracts,
// tv-displays, glofox-import, marketing-import) can be opened up to
// non-master users via their own per-user permissions. HUBS.2d moved
// contracts out to /contracts (see the ADMIN_CHILD_PERMS note below) —
// tv-displays, glofox-import and marketing-import are the ones still
// actually under this tree.
//
// New rule:
//   - master: always allowed (unchanged).
//   - non-master: allowed if they hold ANY of the Studio
//     Management child permissions. Per-page guards then enforce
//     the specific permission for the page they're on.
//   - other /admin/* pages (achievements, audit-log, integrations,
//     matrix) keep their own page-level master gates so the relax
//     here doesn't accidentally open them.
//
// RLS at the data layer is the second line of defence — even if a
// non-master somehow reached an /admin/* page they don't have
// permission for, they'd see no data because RLS enforces tenancy
// + role at the row level.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

// Permissions that grant access to the /admin/* tree. Each target
// page enforces its own specific permission; we only need ONE of
// these here to let the user past the parent layout.
// HYROX-TC.2 — approvals_hyrox_sessions joined the list. HUBS.2b moved
// the Hyrox page itself to /hyrox (out from under this layout), but the
// key stays here so a hyrox-only user can still reach the /admin index,
// where the repointed admin nav card to /hyrox lives.
// HUBS.2d — contracts got the same treatment: the page itself moved to
// /contracts (out from under this layout), but the key stays here so a
// contracts-only user can still reach the /admin index, where the
// repointed admin nav card to /contracts lives.
const ADMIN_CHILD_PERMS = ['contracts', 'tv_displays', 'glofox_import', 'preferences_import', 'approvals_hyrox_sessions']

export default async function AdminLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // user.role flips per active location; profileRole is the canonical
  // global value. Master is platform-wide so we read from profileRole
  // (which is 'master') rather than the per-location role.
  if (user.profileRole === 'master') return children
  // Non-master: at least one Studio Management child permission must
  // be held. Per-page guards inside each /admin/* page enforce the
  // specific permission for that page.
  if (ADMIN_CHILD_PERMS.some((k) => hasPermission(user, k))) return children
  redirect('/')
}
