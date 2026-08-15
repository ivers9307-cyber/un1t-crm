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
