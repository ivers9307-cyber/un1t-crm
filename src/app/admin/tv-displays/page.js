// /admin/tv-displays — TV management surface.
//
// Server-side: pulls the location's TVs + their current content.
// Client component handles register/push/clear interactions.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import TVAdmin from './TVAdmin'

export const dynamic = 'force-dynamic'

export default async function TVDisplaysAdmin() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // STUDIO-GROUP.1 — was role-gated to master/owner/manager; now
  // uses the `tv_displays` permission. Role defaults preserve the
  // old behaviour (ON for those three, OFF for staff + head_coach).
  if (!hasPermission(user, 'tv_displays')) {
    return (
      <div className="p-6">
        <p className="text-sm text-un1t-light">You don&apos;t have access to TV management.</p>
      </div>
    )
  }

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/')

  const db = createServerClient()
  const [{ data: displays }, { data: templates }] = await Promise.all([
    db.from('tv_displays')
      .select('*, tv_content(*)')
      .eq('location_id', locationId)
      .order('created_at', { ascending: true }),
    // TV-TEMPLATE.1 — reusable base-image templates for this location.
    db.from('tv_templates')
      .select('*')
      .eq('location_id', locationId)
      .order('name', { ascending: true }),
  ])

  return (
    <TVAdmin
      initialDisplays={displays || []}
      initialTemplates={templates || []}
      locationId={locationId}
      currentUserId={user.id}
    />
  )
}
