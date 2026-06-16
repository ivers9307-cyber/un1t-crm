// src/app/automations/page.js — Automations home (curated toggles + custom flows).
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { AUTOMATIONS, automationStatus } from '@/lib/automations/registry'
import AutomationsView from '@/components/automations/AutomationsView'
import AutomationsFlowList from '@/components/automations/AutomationsFlowList'

export const dynamic = 'force-dynamic'

export default async function AutomationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canCurated = hasPermission(user, 'automations')
  const canFlows = hasPermission(user, 'email') || hasPermission(user, 'whatsapp')
  if (!canCurated && !canFlows) redirect('/dashboard')

  const location = user.activeLocation
  const db = createServerClient()

  // Curated toggle cards (only when the user has the automations perm).
  let cards = []
  if (canCurated) {
    const { data: rows } = await db
      .from('location_automations')
      .select('automation_key, enabled')
      .eq('location_id', location?.id || '00000000-0000-0000-0000-000000000000')
    const enabledByKey = Object.fromEntries((rows || []).map((r) => [r.automation_key, r.enabled]))
    cards = AUTOMATIONS.map((a) => ({
      key: a.key, label: a.label, description: a.description,
      supportsBackfill: a.supportsBackfill, reviewBase: a.reviewBase,
      enabled: Boolean(enabledByKey[a.key]),
      status: automationStatus(a.key, location),
    }))
  }

  // Custom flows (only when the user has email/whatsapp).
  let sequences = []
  if (canFlows) {
    const { data } = await db
      .from('email_sequences')
      .select('*, sequence_steps(id)')
      .eq('location_id', location?.id)
      .order('created_at', { ascending: false })
    sequences = data || []
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-10">
      {canCurated && (
        <AutomationsView locationId={location?.id || null} locationName={location?.name || ''} cards={cards} />
      )}
      {canFlows && <AutomationsFlowList sequences={sequences} />}
    </div>
  )
}
