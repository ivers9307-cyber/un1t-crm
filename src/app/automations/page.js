// src/app/automations/page.js — Automations hub.
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { AUTOMATIONS, automationStatus } from '@/lib/automations/registry'
import AutomationsView from '@/components/automations/AutomationsView'

export const dynamic = 'force-dynamic'

export default async function AutomationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'automations')) redirect('/dashboard')

  const location = user.activeLocation
  const db = createServerClient()

  const { data: rows } = await db
    .from('location_automations')
    .select('automation_key, enabled')
    .eq('location_id', location?.id || '00000000-0000-0000-0000-000000000000')
  const enabledByKey = Object.fromEntries((rows || []).map((r) => [r.automation_key, r.enabled]))

  const cards = AUTOMATIONS.map((a) => ({
    key: a.key,
    label: a.label,
    description: a.description,
    supportsBackfill: a.supportsBackfill,
    reviewBase: a.reviewBase,
    enabled: Boolean(enabledByKey[a.key]),
    status: automationStatus(a.key, location),
  }))

  return (
    <AutomationsView
      locationId={location?.id || null}
      locationName={location?.name || ''}
      cards={cards}
    />
  )
}
