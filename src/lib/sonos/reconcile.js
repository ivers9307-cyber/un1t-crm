// SONOS.9 — reconcile orchestration. All I/O is injected so this is
// testable with fakes (house pattern: zoom/reconcile.orchestrator.test.js).

import { logWarn } from '@/lib/log'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite, sonosPause } from './client'
import { mapGroups, resolveGroupIds, planAction } from './groups'
// dublinDayStr(instant), NOT dublinTodayStr() — the latter takes no
// argument and always reads the real clock, which would quietly ignore an
// injected `now` and make these tests pass or fail depending on what day
// they are run.
import { dublinDayStr } from '@/lib/dublin-time'

const MODULE = 'sonos-reconcile'

// Pausing a group that has nothing loaded returns 499
// ERROR_PLAYBACK_NO_CONTENT. That is the desired end state, not a failure —
// treat it as success or every close-window tick retries forever.
const pauseSucceeded = (res) => res.ok || res.statusCode === 499

export async function runSonosReconcile(db, deps = {}) {
  const {
    now = () => Date.now(),
    getConfig = () => getSonosConfig(),
    getToken = withFreshToken,
    getGroups = sonosGetGroups,
    setVolume = sonosSetGroupVolume,
    loadFavorite = sonosLoadFavorite,
    pause = sonosPause,
  } = deps

  const cfg = getConfig()
  if (!cfg) return { skipped: true, reason: 'unconfigured' }
  if (cfg.error) {
    logWarn(MODULE, 'misconfigured', { error: cfg.error })
    return { skipped: true, reason: 'misconfigured' }
  }

  const { data: schedules, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('enabled', true)
    .limit(200)
  if (error) {
    logWarn(MODULE, 'schedule load failed', { error: error.message })
    return { ok: false }
  }
  if (!schedules?.length) return { ok: true, applied: 0, failed: 0 }

  const nowMs = now()
  const dateStr = dublinDayStr(nowMs)
  const nowIso = new Date(nowMs).toISOString()

  // Group by location: one household read serves every schedule there.
  const byLocation = new Map()
  for (const s of schedules) {
    if (!byLocation.has(s.location_id)) byLocation.set(s.location_id, [])
    byLocation.get(s.location_id).push(s)
  }

  let applied = 0
  let failed = 0
  let tokenFailures = 0
  let sonosDown = false

  for (const [locationId, rows] of byLocation) {
    const tok = await getToken(db, locationId, cfg)
    if (!tok.ok) {
      tokenFailures++
      logWarn(MODULE, 'token unavailable', { locationId, reason: tok.reason, statusCode: tok.statusCode })
      continue
    }

    const res = await getGroups(tok.token, tok.householdId)
    if (!res.ok) {
      // 401 = revoked/rotated grant; 0 = network. Either way: no DB writes
      // this tick. last_state staleness is the alert, not a thrown error.
      sonosDown = true
      logWarn(MODULE, 'sonos unreachable', { locationId, statusCode: res.statusCode })
      continue
    }

    const { groups } = mapGroups(res.body)

    for (const schedule of rows) {
      const plan = planAction(schedule, nowMs, dateStr)
      if (!plan) continue

      const groupIds = resolveGroupIds(groups, schedule.player_ids)
      if (!groupIds.length) {
        failed++
        logWarn(MODULE, 'no group for schedule players', { scheduleId: schedule.id })
        continue
      }

      let allOk = true
      for (const groupId of groupIds) {
        if (plan.action === 'open') {
          // Volume first: after loadFavorite, the opening seconds would
          // play at the previous window's level.
          const v = await setVolume(tok.token, groupId, plan.volume)
          if (!v.ok) { allOk = false; logWarn(MODULE, 'setVolume failed', { groupId, statusCode: v.statusCode }); continue }
          const f = await loadFavorite(tok.token, groupId, plan.favoriteId)
          if (!f.ok) { allOk = false; logWarn(MODULE, 'loadFavorite failed', { groupId, statusCode: f.statusCode }) }
        } else {
          const p = await pause(tok.token, groupId)
          if (!pauseSucceeded(p)) { allOk = false; logWarn(MODULE, 'pause failed', { groupId, statusCode: p.statusCode }) }
        }
      }

      if (!allOk) {
        // Deliberately do NOT stamp last_applied: leaving the window
        // unapplied means the next tick retries it, which is what a
        // transient 5xx deserves. Stamping it would cost the whole window.
        failed++
        continue
      }

      const primary = groupIds[0]
      const group = groups.find((g) => g.id === primary)
      const { error: upErr } = await db
        .from('sonos_schedules')
        .update({
          last_applied: { window_on_at: plan.windowOnAt, action: plan.action, at: nowIso },
          last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
          updated_at: nowIso,
        })
        .eq('id', schedule.id)
      if (upErr) {
        failed++
        logWarn(MODULE, 'state write failed', { scheduleId: schedule.id, error: upErr.message })
        continue
      }
      applied++
    }
  }

  return { ok: true, applied, failed, tokenFailures, ...(sonosDown ? { sonosDown: true } : {}) }
}
