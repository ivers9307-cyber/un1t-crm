// SONOS.9 — reconcile orchestration. All I/O is injected so this is
// testable with fakes (house pattern: zoom/reconcile.orchestrator.test.js).

import { logWarn } from '@/lib/log'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite, sonosPause } from './client'
import { applyOpen } from './apply'
import { mapGroups, resolveGroupIds, planAction } from './groups'
// dublinDayStr(instant), NOT dublinTodayStr() — the latter takes no
// argument and always reads the real clock, which would quietly ignore an
// injected `now` and make these tests pass or fail depending on what day
// they are run.
import { dublinDayStr } from '@/lib/dublin-time'

const MODULE = 'sonos-reconcile'

// Single source of truth for the schedules-per-tick cap: read by both the
// query's .limit() and the reached-cap check below, so the two can never
// drift apart.
const MAX_SCHEDULES = 200

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
    .limit(MAX_SCHEDULES)
  if (error) {
    logWarn(MODULE, 'schedule load failed', { error: error.message })
    return { ok: false }
  }
  if (schedules?.length === MAX_SCHEDULES) {
    // Reaching the cap means this tick can't tell "exactly MAX_SCHEDULES
    // enabled schedules exist" from "more exist and .limit() silently
    // dropped the rest". Warn either way — it's the only signal an
    // operator gets before some room just quietly stops playing on time.
    logWarn(MODULE, 'schedule cap reached, excess schedules dropped this tick', { cap: MAX_SCHEDULES })
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

      if (plan.action === 'open') {
        const out = await applyOpen(db, {
          token: tok.token,
          schedule,
          plan,
          groups,
          groupIds,
          nowMs,
          deps: { setVolume, loadFavorite },
        })
        if (!out.ok) {
          // Both outcomes count as failed here. 'sonos' leaves the window
          // unapplied so the next tick retries it; 'stamp' means the music
          // is playing but the record did not save, which the next tick
          // will re-open — accepted, and loud in the log either way.
          failed++
          continue
        }
        applied++
        continue
      }

      // Close. Stays here rather than in apply.js: run-now never closes,
      // so there is nothing to share.
      let allOk = true
      for (const groupId of groupIds) {
        const p = await pause(tok.token, groupId)
        if (!pauseSucceeded(p)) { allOk = false; logWarn(MODULE, 'pause failed', { groupId, statusCode: p.statusCode }) }
      }
      if (!allOk) {
        // Deliberately do NOT stamp last_applied: leaving the close
        // unapplied means the next tick retries it.
        failed++
        continue
      }

      const primary = groupIds[0]
      const group = groups.find((g) => g.id === primary)
      const { error: upErr } = await db
        .from('sonos_schedules')
        .update({
          last_applied: { window_on_at: plan.windowOnAt, action: 'close', at: nowIso },
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
