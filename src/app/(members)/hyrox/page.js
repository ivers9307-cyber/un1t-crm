// HYROX-TC.2 — /admin/hyrox planner loader (Server Component).
//
// Mirrors admin/tv-displays/page.js: getCurrentUser -> permission gate ->
// activeLocation -> load the active hyrox_blocks row + its hyrox_sessions ->
// hand off to the client planner. Only one block is ever "active" per
// location (mig 440 status check) — the coach reviews/approves/regenerates
// sessions under it, and Plan 03 owns archiving + starting the next block.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import { resolveHyroxSettings } from '@/lib/hyrox/settings'
import { logError } from '@/lib/log'
import { weekNoFor, slotFor } from '@/lib/hyrox/mapping'
import HyroxPlanner from './HyroxPlanner'

export const dynamic = 'force-dynamic'

export default async function HyroxAdmin() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'approvals_hyrox_sessions')) {
    return (
      <div className="p-6">
        <p className="text-sm text-un1t-subtle">You don&apos;t have access to Hyrox planning.</p>
      </div>
    )
  }

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/')

  const db = createServerClient()
  const { data: block } = await db
    .from('hyrox_blocks')
    .select('*')
    .eq('location_id', locationId)
    .eq('status', 'active')
    .order('starts_on', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: sessions } = block
    ? await db
      .from('hyrox_sessions')
      .select('*')
      .eq('block_id', block.id)
      .order('week_no', { ascending: true })
      .order('slot', { ascending: true })
    : { data: [] }

  // SETTINGSWIPE.1 — a failed read is not "default house style": passing
  // resolveHyroxSettings(null) let Save replace the real style and wipe the
  // saved examples. The planner shows Could not load instead.
  const { data: loc, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .single()
  if (locErr) logError('hyrox-page', 'settings read failed', { locationId, err: locErr.message })

  // The session the NEXT upcoming Hyrox class maps to (same date -> week/slot
  // logic the publish cron uses), so the planner can flag it as "next up".
  let nextUpId = null
  if (block) {
    const { data: nextClasses } = await db
      .from('class_occurrences')
      .select('starts_at')
      .eq('location_id', locationId)
      .is('cancelled_at', null)
      .ilike('name', '%hyrox%')
      .gte('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(1)
    const startsAt = nextClasses?.[0]?.starts_at
    if (startsAt) {
      const wk = weekNoFor(block.starts_on, startsAt, block.weeks)
      const slot = slotFor(block.session_weekdays || [], startsAt)
      nextUpId = (sessions || []).find((s) => s.week_no === wk && s.slot === slot)?.id || null
    }
  }

  return (
    <HyroxPlanner
      initialBlock={block || null}
      initialSessions={sessions || []}
      initialSettings={locErr ? null : resolveHyroxSettings(loc)}
      settingsUnreadable={!!locErr}
      locationId={locationId}
      canManage={['owner', 'manager', 'head_coach', 'master'].includes(user.role)}
      nextUpId={nextUpId}
    />
  )
}
