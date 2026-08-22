// src/lib/sonos/apply.js
// SONOSAPPLY.1 — the one place a Sonos window is OPENED.
//
// Two callers open windows: the reconcile cron (src/lib/sonos/reconcile.js)
// and "Run now" (src/app/api/sonos/schedules/[id]/run-now/route.js). Each
// used to carry its own copy of this sequence, and the copies are where the
// stranded-close bug lived (SONOSLIVE.6): run-now had its own idea of what
// to do with last_applied. Now there is one sequence and one test.
//
// The sequence, per resolved group:
//   1. setVolume FIRST — after loadFavorite the opening seconds would play at
//      the previous window's level. A failed volume skips that group's
//      favourite (no point starting music at the wrong level).
//   2. loadFavorite.
// Then, only if EVERY group succeeded, one UPDATE stamping last_applied +
// last_state. A partial failure stamps nothing, deliberately: an unapplied
// window is retried by the next tick, which is what a transient 5xx
// deserves. Stamping it would cost the whole window.
//
// Three outcomes, kept distinct because the callers treat them differently:
//   { ok: true }
//   { ok: false, reason: 'sonos' }          ≥1 group failed; nothing written
//   { ok: false, reason: 'stamp', error }   Sonos succeeded, the UPDATE did not —
//                                           the music IS playing, only the
//                                           bookkeeping is missing. Run-now
//                                           reports success + warning; the
//                                           cron counts it as failed.

import { logWarn } from '@/lib/log'
import { sonosSetGroupVolume, sonosLoadFavorite } from './client'

const MODULE = 'sonos-apply'

export async function applyOpen(db, { token, schedule, plan, groups, groupIds, nowMs, deps = {} }) {
  const {
    setVolume = sonosSetGroupVolume,
    loadFavorite = sonosLoadFavorite,
  } = deps

  // Nothing to apply → nothing to stamp. Both callers guard this, but the
  // invariant belongs here: an open with zero Sonos calls must never be
  // recorded as applied.
  if (!groupIds?.length) return { ok: false, reason: 'sonos' }

  let allOk = true
  for (const groupId of groupIds) {
    const v = await setVolume(token, groupId, plan.volume)
    if (!v.ok) {
      allOk = false
      logWarn(MODULE, 'setVolume failed', { scheduleId: schedule.id, groupId, statusCode: v.statusCode })
      continue
    }
    const f = await loadFavorite(token, groupId, plan.favoriteId)
    if (!f.ok) {
      allOk = false
      logWarn(MODULE, 'loadFavorite failed', { scheduleId: schedule.id, groupId, statusCode: f.statusCode })
    }
  }
  if (!allOk) return { ok: false, reason: 'sonos' }

  const nowIso = new Date(nowMs).toISOString()
  const primary = groupIds[0]
  const group = (groups || []).find((g) => g.id === primary)
  // window_on_at MUST stay a raw number. A string makes planAction's
  // equality never match, so every tick re-opens and loadFavorite restarts
  // the playlist every sixty seconds. Pinned by apply.test.js.
  const { error } = await db
    .from('sonos_schedules')
    .update({
      last_applied: { window_on_at: plan.windowOnAt, action: 'open', at: nowIso },
      last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
      updated_at: nowIso,
    })
    .eq('id', schedule.id)
  if (error) {
    logWarn(MODULE, 'state write failed', { scheduleId: schedule.id, error: error.message })
    return { ok: false, reason: 'stamp', error }
  }
  return { ok: true }
}
