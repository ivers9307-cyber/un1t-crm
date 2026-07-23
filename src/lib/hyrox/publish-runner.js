// HYROX-TC.3 — reconcile each location's target TV(s) to the CURRENT live
// HYROX class's approved board. Publishes ~lead-time before class; reverts a
// stale cron board to idle when no class is live. Idempotent + push-on-change.
import { normalizeClassName } from '@/lib/hr-analytics'
import { pickSessionForOccurrence, resolveHyroxDisplayIds } from './publish'
import { logWarn } from '@/lib/log'

const LEAD_MS = 15 * 60_000   // put the board up 15 min before class
const POST_MS = 5 * 60_000    // keep it a few min after the start
const TRIGGER = 'cron:hyrox-publish'

export async function runPublishHyroxBoard(db, { nowMs = Date.now() } = {}) {
  const stats = { locations: 0, pushed: 0, reverted: 0 }
  const { data: blocks } = await db
    .from('hyrox_blocks').select('id, location_id, starts_on, weeks, session_weekdays').eq('status', 'active')
  for (const block of blocks || []) {
    stats.locations++
    try {
      const { data: loc } = await db.from('locations').select('id, settings').eq('id', block.location_id).single()
      const { data: displays } = await db.from('tv_displays').select('id, tv_content(source_type, source_ref, triggered_by)').eq('location_id', block.location_id).eq('active', true)
      const activeIds = (displays || []).map((d) => d.id)
      const targetIds = resolveHyroxDisplayIds(loc, activeIds)
      if (!targetIds.length) continue

      // Find a live/imminent HYROX occurrence.
      const { data: occs } = await db.from('class_occurrences')
        .select('glofox_event_id, name, starts_at, ends_at')
        .eq('location_id', block.location_id)
        .is('cancelled_at', null)
        .gte('starts_at', new Date(nowMs - 3 * 60 * 60_000).toISOString())
        .lte('starts_at', new Date(nowMs + LEAD_MS).toISOString())
        .order('starts_at', { ascending: false })
      const live = (occs || []).find((o) => {
        if (normalizeClassName(o.name) !== 'hyrox') return false
        const start = new Date(o.starts_at).getTime()
        const end = o.ends_at ? new Date(o.ends_at).getTime() : start + 60 * 60_000
        return nowMs >= start - LEAD_MS && nowMs <= end + POST_MS
      })

      const session = live ? pickSessionForOccurrence(block, await loadSessions(db, block.id), live.starts_at) : null

      for (const d of displays.filter((x) => targetIds.includes(x.id))) {
        const cur = Array.isArray(d.tv_content) ? d.tv_content[0] : d.tv_content
        if (session) {
          const already = cur && cur.source_type === 'generated' && cur.source_ref === session.id
          if (!already) {
            await db.from('tv_content').upsert({
              tv_display_id: d.id, source_type: 'generated', source_ref: session.id,
              label: 'Hyrox Training Club', template_values: null,
              pushed_at: new Date().toISOString(), pushed_by: null, triggered_by: TRIGGER,
            }, { onConflict: 'tv_display_id' })
            stats.pushed++
          }
        } else if (cur && cur.triggered_by === TRIGGER) {
          // No live class + the board on screen is ours -> revert to idle.
          await db.from('tv_content').delete().eq('tv_display_id', d.id)
          stats.reverted++
        }
      }
      // Mark the session published once (idempotent).
      if (session && session.status !== 'published') {
        await db.from('hyrox_sessions').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', session.id).eq('status', 'approved')
      }
    } catch (err) {
      logWarn('hyrox-publish', `location ${block.location_id} failed`, { err: err?.message })
    }
  }
  return stats
}

async function loadSessions(db, blockId) {
  const { data } = await db.from('hyrox_sessions').select('id, week_no, slot, status').eq('block_id', blockId).in('status', ['approved', 'published'])
  return data || []
}
