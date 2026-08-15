// RADAR-AGENT.0 — operator settings for the customer-facing WhatsApp /
// Instagram agent. Manager+ only. Two parts: behaviour settings + the
// knowledge editor the agent answers from (channel connections moved to
// the per-location Integrations tab strip — IG-HOME.1; a pointer card
// keeps the old path discoverable). Ships OFF by default.
//
// SETTINGS.2g — server gate added. Previously a bare 'use client'
// component with no check of its own, relying entirely on its API routes
// 401/403ing after the page shell had already loaded. Mirrors the write
// path's role check (PUT /api/settings/customer-agent, POST/PUT/DELETE
// /api/agent/knowledge — all MANAGER_ROLES); the read-only GETs those
// routes also expose have no role check, but this page's whole purpose is
// the editor, so gating on the write requirement is the correct mirror
// (never looser than the strictest endpoint it drives).
//
// Task 1 review disclosure: this IS a deliberate tightening, not a pure
// mirror. Before this gate existed, a non-manager holder of the `settings`
// permission (e.g. a permission-granted staff member) could open this page
// and see a working, ungated GET — a de facto read-only view. The
// MANAGER_ROLES gate above removes that read-only path entirely; those
// callers now bounce to /settings. Accepted tradeoff: this page is an
// editor, not a viewer, and the write APIs already gate MANAGER_ROLES, so a
// read-only front door onto an editor-only surface was itself the
// inconsistency being fixed.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import CustomerAgentClient from './CustomerAgentClient'

export const dynamic = 'force-dynamic'

export default async function CustomerAgentSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/settings')
  return <CustomerAgentClient />
}
