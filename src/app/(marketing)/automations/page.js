// src/app/automations/page.js — Automations home (curated toggles + custom flows).
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Music2, Plug } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { AUTOMATIONS } from '@/lib/automations/registry'
import { readGlofoxAutomationStatus } from '@/lib/automations/glofox-status'
import AutomationsView from '@/components/automations/AutomationsView'
import AutomationsFlowList from '@/components/automations/AutomationsFlowList'
import ClassClimateCard from '@/components/automations/ClassClimateCard'
import BathroomClimateCard from '@/components/automations/BathroomClimateCard'

export const dynamic = 'force-dynamic'

const NO_LOCATION = '00000000-0000-0000-0000-000000000000'

// SEQCOUNTERS.1 — what AutomationsFlowList reads, plus (first read only) the
// enrolment count embedded from sequence_enrollments. Module consts so
// check:select-columns resolves both.
const FLOW_COLUMNS = 'id, name, status, trigger_type, created_at, sequence_steps(id)'
const FLOW_COLUMNS_COUNTED = `${FLOW_COLUMNS}, sequence_enrollments(count)`

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
  let glofox = null
  if (canCurated) {
    // PROFILESPREAD.1 — Glofox presence read by id (the user object no
    // longer carries settings). Booleans only reach the client; a failed
    // read is `known: false` and the page says so. The reader never throws
    // (it logs and answers unknown), so running it alongside the
    // location_automations read changes neither read's failure handling.
    let rows
    ;[glofox, { data: rows }] = await Promise.all([
      readGlofoxAutomationStatus(db, location?.id || null),
      db
        .from('location_automations')
        .select('automation_key, enabled, config')
        .eq('location_id', location?.id || NO_LOCATION),
    ])
    const byKey = Object.fromEntries((rows || []).map((r) => [r.automation_key, r]))

    cards = AUTOMATIONS
      .filter((a) => a.key !== 'class_climate' && a.key !== 'bathroom_climate')
      .map((a) => ({
        key: a.key, label: a.label, description: a.description,
        supportsBackfill: a.supportsBackfill, reviewBase: a.reviewBase,
        enabled: Boolean(byKey[a.key]?.enabled),
        status: glofox.statuses[a.key],
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
  // SEQCOUNTERS.1 — named columns (AutomationsFlowList reads id, name,
  // status, trigger_type, sequence_steps, enrolled_count), and the enrolled
  // number is COUNTED from sequence_enrollments in the same read: the
  // email_sequences.total_* counters were never maintained (mig 663).
  // The count must not cost the list: if the read with the embed fails, the
  // list is read again without it and renders with no chips. Only if that
  // fails too is it a notice, never "No automations yet".
  let sequences = []
  let flowsLoadFailed = false
  if (canFlows) {
    const flowsLocationId = location?.id || NO_LOCATION
    const scoped = (query) => query
      .eq('location_id', flowsLocationId)
      .order('created_at', { ascending: false })
    const counted = await scoped(db.from('email_sequences').select(FLOW_COLUMNS_COUNTED))
    if (!counted.error) {
      sequences = (counted.data || []).map(({ sequence_enrollments: enrolments, ...row }) => ({
        ...row,
        enrolled_count: Number(enrolments?.[0]?.count ?? 0),
      }))
    } else {
      logError('automations', 'enrolment count read failed; the flow list renders without counts', { code: counted.error.code || null, locationId: flowsLocationId })
      const plain = await scoped(db.from('email_sequences').select(FLOW_COLUMNS))
      if (!plain.error) {
        sequences = (plain.data || []).map((row) => ({ ...row, enrolled_count: null }))
      } else {
        logError('automations', 'sequences read failed; the flow list shows a notice', { code: plain.error.code || null, locationId: flowsLocationId })
        flowsLoadFailed = true
      }
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-10">
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Automations</h1>
        <p className="text-sm text-un1t-subtle mt-1">Things that run by themselves for {location?.name || 'your studio'}</p>
      </div>
      {canCurated && glofox?.known === false && (
        <p role="alert" className="text-sm bg-amber-500/10 text-amber-700 border border-amber-500/30 rounded-md px-3 py-2">
          Couldn&apos;t check whether Glofox is connected at this location. The automation cards below can&apos;t be changed until it can. Reload to try again.
        </p>
      )}
      {canCurated && (
        <div className="space-y-4">
          <AutomationsView locationId={location?.id || null} locationName={location?.name || ''} cards={cards} />
          <ClassClimateCard
            locationId={location?.id || null}
            glofoxConnected={glofox?.connected === true}
            glofoxUnknown={glofox?.known === false}
            devices={climateDevices}
            initialEnabled={climate?.enabled}
            initialConfig={climate?.config}
          />
          <BathroomClimateCard
            locationId={location?.id || null}
            glofoxConnected={glofox?.connected === true}
            glofoxUnknown={glofox?.known === false}
            devices={climateDevices}
            initialEnabled={bathroom?.enabled}
            initialConfig={bathroom?.config}
          />
        </div>
      )}
      {canDevices && (
        <div className="space-y-4">
          <Link href="/automations/sonos"
            className="block bg-un1t-surface border border-un1t-border rounded-lg p-4 hover:border-un1t-muted transition">
            <div className="flex items-center gap-2">
              <Music2 size={16} className="text-un1t-subtle" />
              <h2 className="font-semibold text-un1t-text">Studio music</h2>
            </div>
            <p className="text-sm text-un1t-subtle mt-1">Scheduled Sonos playback — when the music starts, what plays, and how loud.</p>
          </Link>
          {/* SHELLY-UI.6 — same `device_control` gate as the Sonos card: the
              two surfaces are the same permission, one page each. */}
          <Link href="/automations/shelly"
            className="block bg-un1t-surface border border-un1t-border rounded-lg p-4 hover:border-un1t-muted transition">
            <div className="flex items-center gap-2">
              <Plug size={16} className="text-un1t-subtle" />
              <h2 className="font-semibold text-un1t-text">Smart plugs</h2>
            </div>
            <p className="text-sm text-un1t-subtle mt-1">Shelly plugs and relays — power schedules, live switching, energy use.</p>
          </Link>
        </div>
      )}
      {canFlows && <AutomationsFlowList sequences={sequences} loadFailed={flowsLoadFailed} />}
    </div>
  )
}
