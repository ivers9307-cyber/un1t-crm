// /live/[locationId] — coach view of in-progress HR sessions.
//
// Server shell. Validates the caller can see this location, then
// hands off to a client component that polls /api/live/[locationId]
// every ~2s and renders the live grid + available-straps panel.

import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import LiveClassClient from './LiveClassClient'

export const dynamic = 'force-dynamic'

export default async function LiveClassPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // SEC-LIVE-GATE.1 — this page rendered the coach heart-rate board (live
  // HR sessions, member names) behind only login + location membership.
  // Same gate as src/app/(operations)/studio-management/page.js — the nav
  // and /members hub index both already assume it.
  //
  // SEC-LIVE-API.2 — resolved AT THE TARGET LOCATION, not the active one.
  // The gate used `hasPermission`, which reads activeLocation /
  // activeAssignment / activeRoleTemplate, while the routes this page polls
  // resolve at `params.locationId` (src/lib/live-access.js). That made the
  // page the SOFTER half of its own gate, and prod had the divergence: an
  // account that is manager at Hatch (permission granted) and manager at
  // Stillorgan with an explicit `studio_management: false` passed the page
  // gate with Hatch selected, rendered the board shell for Stillorgan, and
  // then had every ~2s poll 403 — a board that loads and never fills.
  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    notFound()
  }
  if (!hasPermissionForLocation(user, locationId, 'studio_management')) redirect('/')

  // Pull the location name. Member search is now server-side via
  // /api/live/[locationId]/contacts so we no longer preload contacts here.
  const db = createServerClient()
  const { data: location } = await db
    .from('locations')
    .select('id, name')
    .eq('id', locationId)
    .single()

  if (!location) notFound()

  return (
    <LiveClassClient
      locationId={locationId}
      locationName={location.name}
    />
  )
}
