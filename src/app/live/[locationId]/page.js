// /live/[locationId] — coach view of in-progress HR sessions.
//
// Server shell. Validates the caller can see this location, then
// hands off to a client component that polls /api/live/[locationId]
// every ~2s and renders the live grid + available-straps panel.

import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import LiveClassClient from './LiveClassClient'

export const dynamic = 'force-dynamic'

export default async function LiveClassPage(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    notFound()
  }

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
