// INCLUSION-CORE T5 — operator editor for the UN1T-Points scoring
// figures: the five per-minute HR-zone point rates (Z1–Z5) plus the
// participation-points award for attending a class with no HR data.
// Manager+ only. Stored on locations.settings.scoring; read by the
// scoring engine (resolveScoringConfig). Mirrors the customer-agent
// settings page's primitives + dark-on-light tokens. Tuning the numbers
// is a settings write, not a code change.
//
// SETTINGS.2g — server gate added. Previously a bare 'use client'
// component with no check of its own, relying entirely on PUT
// /api/settings/scoring 403ing after the page shell had already loaded
// (GET is open to any signed-in user, same shape as
// /api/settings/customer-agent). Mirrors the write path's MANAGER_ROLES
// check — this page's whole purpose is the editor, so gating on the write
// requirement is the correct mirror.
//
// Task 1 review disclosure: this IS a deliberate tightening, not a pure
// mirror. Before this gate existed, a non-manager holder of the `settings`
// permission could open this page and see a working, ungated GET — a de
// facto read-only view. The MANAGER_ROLES gate above removes that
// read-only path entirely; those callers now bounce to /settings.
// Accepted tradeoff: this page is an editor, not a viewer, and the write
// API already gates MANAGER_ROLES, so a read-only front door onto an
// editor-only surface was itself the inconsistency being fixed.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import ScoringClient from './ScoringClient'

export const dynamic = 'force-dynamic'

export default async function ScoringSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/settings')
  return <ScoringClient />
}
