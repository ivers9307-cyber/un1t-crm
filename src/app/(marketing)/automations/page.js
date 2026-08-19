// src/app/automations/page.js — Automations home (curated toggles + custom flows).
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Plug } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { AUTOMATIONS, automationStatus, glofoxConnected } from '@/lib/automations/registry'
import AutomationsView from '@/components/automations/AutomationsView'
import AutomationsFlowList from '@/components/automations/AutomationsFlowList'
import ClassClimateCard from '@/components/automations/ClassClimateCard'
import BathroomClimateCard from '@/components/automations/BathroomClimateCard'

export const dynamic = 'force-dynamic'

const NO_LOCATION = '00000000-0000-0000-0000-000000000000'

export default async function AutomationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canCurated = hasPermission(user, 'automations')
  const canFlows = hasPermission(user, 'email') || hasPermission(user, 'whatsapp')
  const canDevices = hasPermission(user, 'device_control')
  if (!canCurated && !canFlows && !canDevices) redirect('/dashboard')

  const location = user.activeLocation
  const db = createServerClient()

  // Curated toggle cards (only when the user has the automations perm).
  // class_climate + bathroom_climate are rendered by their own cards (they
  // need config), so they're filtered out of the generic toggle list.
  let cards = []
  let climate = null
  let bathroom = null
  let climateDevices = []
  if (canCurated) {
    const { data: rows } = await db
      .from('location_automations')
      .select('automation_key, enabled, config')
      .eq('location_id', location?.id || NO_LOCATION)
    const byKey = Object.fromEntries((rows || []).map((r) => [r.automation_key, r]))

    cards = AUTOMATIONS
      .filter((a) => a.key !== 'class_climate' && a.key !== 'bathroom_climate')
      .map((a) => ({
        key: a.key, label: a.label, description: a.description,
        supportsBackfill: a.supportsBackfill, reviewBase: a.reviewBase,
        enabled: Boolean(byKey[a.key]?.enabled),
        status: automationStatus(a.key, location),
      }))

    const { data: devices } = await db
      .from('ac_devices')
      .select('id, label, provider, enabled')
      .eq('location_id', location?.id || NO_LOCATION)
      .order('label', { ascending: true })
    climateDevices = devices || []
    const row = byKey['class_climate']
    climate = { enabled: Boolean(row?.enabled), config: row?.config || {} }
    const bathroomRow = byKey['bathroom_climate']
    bathroom = { enabled: Boolean(bathroomRow?.enabled), config: bathroomRow?.config || {} }
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
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Automations</h1>
        <p className="text-sm text-un1t-subtle mt-1">Things that run by themselves for {location?.name || 'your studio'}</p>
      </div>
      {canCurated && (
        <div className="space-y-4">
          <AutomationsView locationId={location?.id || null} locationName={location?.name || ''} cards={cards} />
          <ClassClimateCard
            locationId={location?.id || null}
            glofoxConnected={glofoxConnected(location)}
            devices={climateDevices}
            initialEnabled={climate?.enabled}
            initialConfig={climate?.config}
          />
          <BathroomClimateCard
            locationId={location?.id || null}
            glofoxConnected={glofoxConnected(location)}
            devices={climateDevices}
            initialEnabled={bathroom?.enabled}
            initialConfig={bathroom?.config}
          />
        </div>
      )}
      {canDevices && (
        <Link href="/automations/devices"
          className="block bg-un1t-surface border border-un1t-border rounded-lg p-4 hover:border-un1t-muted transition">
          <div className="flex items-center gap-2">
            <Plug size={16} className="text-un1t-subtle" />
            <h2 className="font-semibold text-un1t-text">Devices</h2>
          </div>
          <p className="text-sm text-un1t-subtle mt-1">Schedules &amp; class-linked power for smart plugs and switches.</p>
        </Link>
      )}
      {canFlows && <AutomationsFlowList sequences={sequences} />}
    </div>
  )
}
