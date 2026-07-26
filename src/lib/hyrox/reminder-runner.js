// HYROX-MOBILE (Batch D) — remind the coach(es) covering a HYROX class to review
// the workout, ~30 min before it starts. Runs on the every-5-min cron; the
// hyrox_class_reminders unique (location, class_starts_at) makes it send ONCE per
// class, not every tick. Primary recipients are whoever's rostered on at the
// class time (hyrox_coaches_on_shift, TZ-safe in SQL); if the roster has a gap,
// fall back to the location's Hyrox-approver roles so a reminder never goes to
// nobody. sendPush gates on the master push switch + the `hyrox` mobile feature.
import { normalizeClassName } from '@/lib/hr-analytics'
import { weekNoFor, slotFor } from './mapping'
import { sendPush, resolveRoleRecipientIds } from '@/lib/push'
import { logWarn } from '@/lib/log'

const LEAD_MS = 30 * 60_000        // remind 30 min before the class
const FALLBACK_ROLES = ['owner', 'manager', 'head_coach']

export async function runHyroxClassReminder(db, { nowMs = Date.now() } = {}) {
  const stats = { classes: 0, reminded: 0, recipients: 0 }
  const { data: blocks } = await db
    .from('hyrox_blocks').select('id, location_id, starts_on, weeks, session_weekdays').eq('status', 'active')

  for (const block of blocks || []) {
    try {
      const { data: occs } = await db.from('class_occurrences')
        .select('name, starts_at, ends_at')
        .eq('location_id', block.location_id)
        .is('cancelled_at', null)
        .gte('starts_at', new Date(nowMs).toISOString())
        .lte('starts_at', new Date(nowMs + LEAD_MS).toISOString())
        .order('starts_at', { ascending: true })

      for (const occ of occs || []) {
        if (!normalizeClassName(occ.name).includes('hyrox')) continue
        stats.classes++

        // Claim this occurrence race-safely — ON CONFLICT DO NOTHING. Only the
        // insert that actually wrote a row proceeds to send; a second tick (or a
        // concurrent run) gets no rows back and skips.
        const { data: claimed } = await db.from('hyrox_class_reminders')
          .upsert({ location_id: block.location_id, class_starts_at: occ.starts_at },
                  { onConflict: 'location_id,class_starts_at', ignoreDuplicates: true })
          .select('id')
        if (!claimed || !claimed.length) continue
        const reminderId = claimed[0].id

        // The session this class maps to (for the deep-link + focus). Any status
        // — the coach reviews a draft too.
        const wk = weekNoFor(block.starts_on, occ.starts_at, block.weeks)
        const slot = slotFor(block.session_weekdays || [], occ.starts_at)
        let session = null
        if (wk != null && slot != null) {
          const { data: s } = await db.from('hyrox_sessions')
            .select('id, focus').eq('block_id', block.id).eq('week_no', wk).eq('slot', slot).maybeSingle()
          session = s || null
        }

        // Who's on shift at the class time; else the Hyrox-approver roles.
        const endIso = occ.ends_at || new Date(new Date(occ.starts_at).getTime() + 60 * 60_000).toISOString()
        const { data: onShift } = await db.rpc('hyrox_coaches_on_shift', {
          p_location: block.location_id, p_start: occ.starts_at, p_end: endIso,
        })
        let recipientIds = (onShift || []).map((r) => r.profile_id).filter(Boolean)
        if (!recipientIds.length) {
          const fallback = await resolveRoleRecipientIds(db, block.location_id, FALLBACK_ROLES)
          recipientIds = [...(fallback || [])]
        }
        if (!recipientIds.length) continue

        const timeStr = new Date(occ.starts_at).toLocaleTimeString('en-IE', {
          timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
        })
        await sendPush(recipientIds, {
          title: 'Hyrox class coming up',
          body: session?.focus
            ? `Review "${session.focus}" for your ${timeStr} class.`
            : `Review the workout for your ${timeStr} Hyrox class.`,
          data: session?.id ? { screen: 'hyrox', sessionId: session.id } : { screen: 'hyrox' },
        }, { locationId: block.location_id, requireMobileKey: 'hyrox' })

        // Best-effort bookkeeping — never fails the send.
        await db.from('hyrox_class_reminders')
          .update({ session_id: session?.id || null, recipient_count: recipientIds.length })
          .eq('id', reminderId)
        stats.reminded++
        stats.recipients += recipientIds.length
      }
    } catch (err) {
      logWarn('hyrox-reminder', `location ${block.location_id} failed`, { err: err?.message })
    }
  }
  return stats
}
