// RADAR-AGENT Phase 2 — operator approval queue. Manager+ reviews the
// pause / cancellation requests the customer agent captured, and decides:
// Approve, Decline, or (for cancellations) Save (retention kept them).
// The actual Glofox change is made by staff after approving.
//
// SETTINGS.2g — server gate added. Previously a bare 'use client'
// component with no check of its own, relying entirely on GET
// /api/agent/membership-requests 403ing after the page shell had already
// loaded. Mirrors that route's full-history branch (no conversation_id —
// the one this page's initial load hits), which gates on MANAGER_ROLES.
// The per-row decide action (PATCH .../[id]) gates on a separate,
// deliberately broader per-category permission
// (APPROVAL_CATEGORY_PERMISSION.agent_requests) — that only governs the
// decide button inside the client component, not landing on the page and
// loading the queue, so it stays out of scope for this page-level gate.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import AgentRequestsClient from './AgentRequestsClient'

export const dynamic = 'force-dynamic'

export default async function AgentRequestsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/settings')
  return <AgentRequestsClient />
}
