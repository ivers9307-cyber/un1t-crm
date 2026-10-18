// HATCHPIPE.2 — an hourly reclassify of a un1t.online studio's board, riding
// the un1t-online-sync cron (every 15 min) after a GOOD sync.
//
// The nightly pipeline-classify cron is too slow for a studio whose membership
// state arrives every 15 minutes, and the sync runs the freshest data in the
// estate, so the sync cron calls this once per ok location. It decides whether
// a pass is due; the pass itself is reclassifyAllContacts (source 'cron').
//
// Never throws: the caller is a cron loop whose outcome and heartbeat must not
// depend on this (a runner never kills other work).

import { getBoardModule } from '../../shared/pipelines/index.js'
import { reclassifyAllContacts } from './pipeline-reclassify.js'
import { logError } from './log.js'

// Slightly under an hour so a 15-minute tick that lands a little early still
// runs: runs spaced 60 minutes apart by tick jitter never skip a slot.
export const RECLASSIFY_MIN_GAP_MS = 55 * 60 * 1000

// A pass still 'running' (finished_at null) that started inside this window is
// in flight: the next tick waits for it rather than stacking a second pass
// behind it. One older than this is stuck (a killed function never closes its
// audit row) and does not hold the board off.
export const RECLASSIFY_IN_FLIGHT_MS = 10 * 60 * 1000

const UN1T_INPUT = 'un1t_online'

/**
 * @param {object} db service-role client
 * @param {string} locationId
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ ran: false, reason: 'no_un1t_board'|'recent_run'|'error'|'timeout' } | { ran: true, result: object }>}
 *   ('timeout' is only ever produced by the sync cron's deadline race around this call.)
 */
export async function maybeReclassifyAfterSync(db, locationId, { now = Date.now() } = {}) {
  try {
    const { data: boards, error: boardsErr } = await db
      .from('pipelines')
      .select('module')
      .eq('location_id', locationId)
      .eq('enabled', true)
    if (boardsErr) throw boardsErr
    if (!(boards || []).some((b) => getBoardModule(b.module)?.inputSource === UN1T_INPUT)) {
      return { ran: false, reason: 'no_un1t_board' }
    }

    const { data: runs, error: runsErr } = await db
      .from('pipeline_classification_runs')
      .select('started_at, finished_at, status')
      .eq('location_id', locationId)
      .order('started_at', { ascending: false })
      .limit(1)
    if (runsErr) throw runsErr
    const last = runs?.[0]
    // A FAILED pass (un1t inputs unavailable) does not hold the next tick off:
    // reclassify itself says those are "retried next tick".
    if (last?.finished_at && last.status !== 'failed') {
      const finishedMs = Date.parse(last.finished_at)
      if (Number.isFinite(finishedMs) && now - finishedMs < RECLASSIFY_MIN_GAP_MS) {
        return { ran: false, reason: 'recent_run' }
      }
    }
    if (last && !last.finished_at && last.status === 'running') {
      const startedMs = Date.parse(last.started_at)
      if (Number.isFinite(startedMs) && now - startedMs < RECLASSIFY_IN_FLIGHT_MS) {
        return { ran: false, reason: 'recent_run' }
      }
    }

    const result = await reclassifyAllContacts(db, { locationId, source: 'cron' })
    return { ran: true, result }
  } catch (err) {
    // Name only, never the message (a token could ride in one).
    logError('un1t-pipeline-cadence', 'reclassify after sync failed', {
      locationId,
      reason: 'error',
      errName: err?.name ?? null,
    })
    return { ran: false, reason: 'error' }
  }
}
