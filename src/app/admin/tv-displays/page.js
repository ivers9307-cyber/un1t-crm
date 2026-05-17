// /admin/tv-displays — TV management surface.
//
// Server-side: pulls the location's TVs + their current content.
// Client component handles register/push/clear interactions.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import TVAdmin from './TVAdmin'

export const dynamic = 'force-dynamic'

export default async function TVDisplaysAdmin() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Master/owner/manager only — TV management is a marketing /
  // operator concern, not for general staff.
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return (
      <div className="p-6">
        <p className="text-sm text-un1t-light">You don&apos;t have access to TV management.</p>
      </div>
    )
  }

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/')

  const db = createServerClient()
  const { data: displays } = await db
    .from('tv_displays')
    .select('*, tv_content(*)')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })

  return (
    <TVAdmin
      initialDisplays={displays || []}
      locationId={locationId}
      currentUserId={user.id}
    />
  )
}
