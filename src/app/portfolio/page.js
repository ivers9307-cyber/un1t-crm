// /portfolio — Repset ACCOUNT-tier home (org portfolio).
//
// REPSET-ACCOUNT.1. The Account tier sits between Platform (master,
// cross-tenant — a LATER phase) and Studio (a single location's CRM).
// This page rolls up headline KPIs across the active org's studios and
// drills into one via "Open studio →".
//
// NOTE ON THE ROUTE NAME: the proposal called this "/account", but
// `/account` is already the per-user self-service account page
// (landing preference, password, PIN, contracts). Overwriting it would
// break every signed-in user, so the org portfolio lives at /portfolio.
//
// Guard: owner-of-active-org or master → else redirect to /dashboard.
// LOOP-SAFETY: this page only ever redirects to /dashboard (never to /
// or back to /portfolio), and /dashboard never redirects here, so the
// login router ↔ portfolio ↔ studio-drill-in path cannot loop.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  resolveAccountScope,
  fetchOrgLocations,
  assembleAccountHome,
} from '@/lib/account-home'
import AccountHome from '@/components/account/AccountHome'

export const dynamic = 'force-dynamic'

export default async function PortfolioPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Owner+/master gate — mirrors the sidebar's masterOrOwnerOnly entry.
  // `user.role` is the active-location role (an org owner reads 'owner').
  const canView = user.isMaster || user.role === 'master' || user.role === 'owner'
  if (!canView) redirect('/dashboard')

  // Authorise the active org (no ?organization_id switching from the UI in
  // this phase — master org selection is via the API param).
  const scope = resolveAccountScope(user, null)
  if (!scope.ok) redirect('/dashboard')

  const db = createServerClient()
  const { data: org } = await db
    .from('organizations')
    .select('id, name, slug')
    .eq('id', scope.orgId)
    .maybeSingle()
  if (!org) redirect('/dashboard')

  const locations = await fetchOrgLocations(db, scope.orgId)
  const data = await assembleAccountHome(db, { organization: org, locations })

  return <AccountHome data={data} activeLocationId={user.activeLocation?.id || null} />
}
