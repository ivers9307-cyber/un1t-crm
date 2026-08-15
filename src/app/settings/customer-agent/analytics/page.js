// RADAR-AGENT — agent analytics / "needs review" feed (plan §4e).
// Manager+ operator screen: headline numbers, containment rate,
// most-asked topics, and the list of conversations the agent escalated
// (each links to its channel inbox). Read-only; trailing-window.
//
// SETTINGS.2g — server gate added. Previously a bare 'use client'
// component with no check of its own, relying entirely on GET
// /api/agent/analytics 403ing after the page shell had already loaded.
// Mirrors that route's MANAGER_ROLES check exactly.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import AgentAnalyticsClient from './AgentAnalyticsClient'

export const dynamic = 'force-dynamic'

export default async function AgentAnalyticsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/settings')
  return <AgentAnalyticsClient />
}
