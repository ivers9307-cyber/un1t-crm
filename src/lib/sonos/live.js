// SONOSLIVE.3 — live control orchestration. All I/O injected so the
// properties that matter are testable with fakes (house pattern:
// src/lib/sonos/reconcile.js).
//
// THIS WRITES NOTHING TO sonos_schedules, deliberately. The schedule acts
// only at window boundaries and ignores everything in between, so a live
// change simply persists until the next boundary — no suppression, no
// reconciliation, no new state. There is a test asserting this; if someone
// later adds a "helpful" last_applied stamp here, it fails loudly rather
// than silently breaking the close.
//
// It also works while the schedule is disabled or overridden: both govern
// whether the CRON acts, not whether a human may. Someone who just
// suppressed the schedule for a private event is exactly who then wants to
// set the volume by hand — which is why neither field is even read here.

import { logWarn } from '@/lib/log'
import {
  getSonosConfig, withFreshToken, sonosGetGroups, sonosGetGroupVolume,
  sonosSetGroupVolume, sonosSetRelativeVolume, sonosLoadFavorite,
  sonosPlay, sonosPause, sonosSkipNext, sonosSkipPrevious,
} from './client'
import { mapGroups, resolveGroupIds } from './groups'
import { planLiveAction } from './actions'

const MODULE = 'sonos-live'

const CLIENT = {
  setVolume: sonosSetGroupVolume,
  setRelativeVolume: sonosSetRelativeVolume,
  loadFavorite: sonosLoadFavorite,
  play: sonosPlay,
  pause: sonosPause,
  skipNext: sonosSkipNext,
  skipPrevious: sonosSkipPrevious,
}

const defaultCall = (name, token, groupId, ...args) => CLIENT[name](token, groupId, ...args)

// → { ok: true, groups }
// | { ok: false, code, reason?, statusCode?, applied?, failedGroups? }
//
// `target` is { scheduleId } XOR { groupId } — exactly one, truthy. The
// routes enforce exactly-one before calling; this function re-checks as
// defence in depth and answers { ok: false, code: 'invalid' } for anything
// else (including the old positional string signature).
//
// The schedule path loads the row scoped to the location and resolves
// group ids from player_ids. The group path reads NO db row at all — the
// db is used only by getToken. Nothing needs authorising beyond the
// location's own token: it scopes the household, so a foreign group id is
// simply absent from the groups fetch and answers `regrouped` (group ids
// are ephemeral by design, so "the speakers regrouped — try that again"
// is the honest copy, not no_group's schedule-speaker wording).
//
// `code` is a stable tag the route maps to an HTTP status and copy.
//
// `applied` and `failedGroups` appear only on a dispatch-loop failure, and
// only matter for a multi-group schedule: they say which speakers already
// changed before something went wrong. The caller needs that because
// volume_up/volume_down are RELATIVE and so not idempotent — retrying the
// whole action would move an already-changed group a second time. Note
// there is currently no way to scope a retry to failedGroups; the fields
// are informational, so a UI should surface a partial failure rather than
// auto-retry a volume action.
export async function runLiveAction(db, locationId, target, action, value, deps = {}) {
  const {
    getConfig = () => getSonosConfig(),
    getToken = withFreshToken,
    getGroups = sonosGetGroups,
    getGroupVolume = sonosGetGroupVolume,
    call = defaultCall,
  } = deps

  // Exactly-one target, checked before any I/O. The routes also enforce
  // this; here it is the backstop.
  const isTargetObject = target !== null && typeof target === 'object'
  const scheduleId = isTargetObject ? target.scheduleId : undefined
  const groupId = isTargetObject ? target.groupId : undefined
  if (!isTargetObject || (!scheduleId && !groupId) || (scheduleId && groupId)) {
    return { ok: false, code: 'invalid' }
  }
  const targetMeta = scheduleId ? { scheduleId } : { groupId }

  const plan = planLiveAction(action, value)
  if (!plan) return { ok: false, code: 'invalid' }

  const cfg = getConfig()
  if (!cfg) return { ok: false, code: 'not_configured' }
  if (cfg.error) return { ok: false, code: 'not_configured', reason: cfg.error }

  let schedule = null
  if (scheduleId) {
    // Location scoping lives on the query, not a read-then-check: a schedule
    // id from another location must be indistinguishable from one that does
    // not exist.
    const { data, error } = await db
      .from('sonos_schedules')
      .select('id, player_ids')
      .eq('id', scheduleId)
      .eq('location_id', locationId)
      .maybeSingle()
    if (error) return { ok: false, code: 'db_error', reason: error.message }
    if (!data) return { ok: false, code: 'not_found' }
    schedule = data
  }

  const tok = await getToken(db, locationId, cfg)
  if (!tok.ok) return { ok: false, code: 'not_connected', reason: tok.reason }

  const groupsRes = await getGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) return { ok: false, code: 'unreachable', statusCode: groupsRes.statusCode }

  const { groups } = mapGroups(groupsRes.body)
  let groupIds
  if (scheduleId) {
    groupIds = resolveGroupIds(groups, schedule.player_ids)
    if (!groupIds.length) return { ok: false, code: 'no_group' }
  } else {
    groupIds = groups.some((g) => g.id === groupId) ? [groupId] : []
    if (!groupIds.length) return { ok: false, code: 'regrouped' }
  }

  // A fixed-level group ignores volume commands. Refuse rather than firing
  // something that silently does nothing. Only checked when it matters —
  // an extra GET on every skip would be waste.
  //
  // Fail OPEN on a failed read (vol.ok === false): deliberately, not by
  // accident. The alternative — refusing every volume change whenever this
  // GET blips — would block the common case to guard the rare one (a
  // genuinely fixed-level group). The accepted cost of failing open: on an
  // actually-fixed group, the volume command still fires, Sonos accepts it
  // and silently does nothing, and the caller gets a false-positive
  // success. That trade is preferred over refusing volume control estate-
  // wide on a transient read failure.
  if (plan.touchesVolume) {
    const vol = await getGroupVolume(tok.token, groupIds[0])
    if (vol.ok && vol.body?.fixed === true) return { ok: false, code: 'fixed_volume' }
  }

  const results = []
  for (const groupId of groupIds) {
    results.push({ groupId, ...(await call(plan.call, tok.token, groupId, ...plan.args)) })
  }

  const failed = results.find((r) => !r.ok)
  if (failed) {
    logWarn(MODULE, 'action failed', { ...targetMeta, action, statusCode: failed.statusCode })

    // Groups already called before the failure are NOT undone — report
    // both sides rather than letting `ok: false` read as "nothing
    // happened". This matters most for volume_up/volume_down: they are
    // NOT idempotent, so a caller that sees a bare failure and retries the
    // whole action would apply the relative step a second time to a group
    // in `applied`. `code` keeps its existing meaning/mapping; `applied`
    // and `failedGroups` let a retry target only what didn't land.
    const applied = results.filter((r) => r.ok).map((r) => r.groupId)
    const failedGroups = results.filter((r) => !r.ok).map((r) => r.groupId)

    // 404 = the group changed between resolve and act. Retryable, but not
    // retried in-request — the caller re-resolves on their next attempt.
    if (failed.statusCode === 404) return { ok: false, code: 'regrouped', applied, failedGroups }
    if (failed.statusCode === 499) return { ok: false, code: 'no_content', applied, failedGroups }
    if (failed.statusCode === 429) return { ok: false, code: 'rate_limited', applied, failedGroups }
    return { ok: false, code: 'failed', statusCode: failed.statusCode, applied, failedGroups }
  }

  return { ok: true, groups: groupIds }
}
