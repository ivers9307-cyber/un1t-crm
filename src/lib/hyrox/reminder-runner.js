// HYROX-MOBILE (Batch D) — remind the coach(es) covering a HYROX class to review
// the workout, ~30 min before it starts. Runs on the every-5-min cron; the
// hyrox_class_reminders unique (location, class_starts_at) makes it send ONCE per
// class, not every tick. Primary recipients are whoever's rostered on at the
// class time (hyrox_coaches_on_shift, TZ-safe in SQL); if the roster has a gap,
// fall back to the location's Hyrox-approver roles so a reminder never goes to
// nobody. sendPush gates on the master push switch + the `hyrox` mobile feature.
//
// C1 RECIPIENTS.1 — WHO is worked out BEFORE the class is claimed. The claim
// used to come first, so a failed approver read (which came back as [])
// claimed the class with nobody told, and every later tick skipped it: the
// reminder was lost for good. Now a failed read claims nothing and the next
// tick (5 minutes later, still inside the 30-minute lead) tries again; so
// does "nobody to tell", in case a coach is rostered in the meantime.
import { normalizeClassName } from '@/lib/hr-analytics'
import { weekNoFor, slotFor } from './mapping'
import { sendPush, readRoleRecipientIds } from '@/lib/push'
import { logWarn, logError } from '@/lib/log'

const LEAD_MS = 30 * 60_000        // remind 30 min before the class
const FALLBACK_ROLES = ['owner', 'manager', 'head_coach']

// Who's on shift at the class time; else the Hyrox-approver roles.
// { ids, error }: error is set ONLY when the fallback roles read failed. A
// failed on-shift read degrades to the fallback, as it always has, logged.
async function classRecipients(db, locationId, occ) {
  const endIso = occ.ends_at || new Date(new Date(occ.starts_at).getTime() + 60 * 60_000).toISOString()
  const { data: onShift, error: shiftErr } = await db.rpc('hyrox_coaches_on_shift', {
    p_location: locationId, p_start: occ.starts_at, p_end: endIso,
  })
  if (shiftErr) {
    logWarn('hyrox-reminder', 'on-shift read failed; reminding the approver roles instead', {
      locationId, class_starts_at: occ.starts_at, err: shiftErr.message,
    })
  }
  const ids = (shiftErr ? [] : (onShift || [])).map((r) => r.profile_id).filter(Boolean)
  if (ids.length) return { ids, error: null }

  const fallback = await readRoleRecipientIds(db, locationId, FALLBACK_ROLES)
  if (fallback.error) return { ids: [], error: fallback.error.message }
  return { ids: [...fallback.ids], error: null }
}

export async function runHyroxClassReminder(db, { nowMs = Date.now() } = {}) {
  const stats = { classes: 0, reminded: 0, recipients: 0, recipients_failed: 0, send_failed: 0, claim_failed: 0 }
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

        // Already reminded? Skip BEFORE reading recipients, so a transient
        // recipients-read failure on a later tick cannot log "nothing claimed,
        // the next tick retries" (and count recipients_failed) for a class that
        // was reminded long ago. Only an early-out: if this read errors we fall
        // through, and the ON CONFLICT claim below stays the real guard.
        const { data: already, error: alreadyErr } = await db.from('hyrox_class_reminders')
          .select('id').eq('location_id', block.location_id).eq('class_starts_at', occ.starts_at)
          .maybeSingle()
        if (!alreadyErr && already) continue

        const recipients = await classRecipients(db, block.location_id, occ)
        if (recipients.error) {
          stats.recipients_failed++
          logError('hyrox-reminder', 'approver read failed; nothing claimed, the next tick retries', {
            locationId: block.location_id, class_starts_at: occ.starts_at, err: recipients.error,
          })
          continue
        }
        const recipientIds = recipients.ids
        if (!recipientIds.length) continue

        // Claim this occurrence race-safely — ON CONFLICT DO NOTHING. Only the
        // insert that actually wrote a row proceeds to send; a second tick (or a
        // concurrent run) gets no rows back and skips.
        // C21 PUSHDONE.1 (F3) — a FAILED claim is not "already claimed": it was
        // read that way in silence. Nothing is sent without a claim (sending
        // unclaimed could repeat every tick); the next 5-minute tick, still
        // inside the 30-minute lead, tries again, and the failure is said.
        const { data: claimed, error: claimErr } = await db.from('hyrox_class_reminders')
          .upsert({ location_id: block.location_id, class_starts_at: occ.starts_at },
                  { onConflict: 'location_id,class_starts_at', ignoreDuplicates: true })
          .select('id')
        if (claimErr) {
          stats.claim_failed++
          logWarn('hyrox-reminder', 'claim write failed; nothing sent, the next tick retries', {
            locationId: block.location_id, class_starts_at: occ.starts_at, err: claimErr.message,
          })
          continue
        }
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

        const timeStr = new Date(occ.starts_at).toLocaleTimeString('en-IE', {
          timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
        })
        const result = await sendPush(recipientIds, {
          title: 'Hyrox class coming up',
          body: session?.focus
            ? `Review "${session.focus}" for your ${timeStr} class.`
            : `Review the workout for your ${timeStr} Hyrox class.`,
          data: session?.id ? { screen: 'hyrox', sessionId: session.id } : { screen: 'hyrox' },
        }, { locationId: block.location_id, requireMobileKey: 'hyrox' })

        // C16 PUSHREADERR.1 — the class was claimed BEFORE the send. Nothing
        // delivered because something FAILED (a read inside sendPush, or Expo
        // after its retries): release the claim, so the next 5-minute tick,
        // still inside the 30-minute lead, tries again. Anything delivered
        // keeps it (a partial send must never repeat), and so does "nobody
        // has a device" (sent 0, failed 0): nothing to retry against.
        if ((result?.sent || 0) === 0 && (result?.failed || 0) > 0) {
          stats.send_failed++
          const where = { locationId: block.location_id, class_starts_at: occ.starts_at, read_failed: !!result?.read_failed }
          const { error: releaseErr } = await db.from('hyrox_class_reminders').delete().eq('id', reminderId)
          if (releaseErr) {
            logError('hyrox-reminder', 'nothing delivered and the claim release failed; this class will not be reminded', { ...where, err: releaseErr.message })
          } else {
            logWarn('hyrox-reminder', 'nothing delivered; claim released, the next tick retries', where)
          }
          continue
        }

        // Best-effort bookkeeping — never fails the send (F3: now said when lost).
        const { error: bookErr } = await db.from('hyrox_class_reminders')
          .update({ session_id: session?.id || null, recipient_count: recipientIds.length })
          .eq('id', reminderId)
        if (bookErr) {
          logWarn('hyrox-reminder', 'reminder bookkeeping write failed; the reminder was sent', { reminderId, err: bookErr.message })
        }
        stats.reminded++
        stats.recipients += recipientIds.length
      }
    } catch (err) {
      logWarn('hyrox-reminder', `location ${block.location_id} failed`, { err: err?.message })
    }
  }
  return stats
}
