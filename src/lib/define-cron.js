// defineCron — the one way a scheduled job starts, fails and reports health.
//
//   export const maxDuration = 60   // Next reads this from the route file
//
//   export const GET = defineCron({ heartbeat: 'class-climate' }, async ({ db }) => {
//     const out = await runClassClimate(db, {})
//     return { ok: out.ok !== false, body: out }
//   })
//
// The wrapper owns four things every job used to write by hand:
//   - the CRON_SECRET check, refused when the secret is unset;
//   - the service-role client, created only after that check;
//   - one error boundary: a throw is logged and answered with a fixed 500, so
//     error text never leaves in a response;
//   - the heartbeat rule: stamped only for a run that did not fail.
//
// The job returns { ok, body, outcome, status }, all optional:
//   ok       false when the RUN failed: a whole-run read failed, or every studio
//            did. One contact or one message failing is not a failed run; report
//            it in `body` and leave ok alone, or a single bad row pages the team.
//   body     extra JSON fields for the response, beside `success`.
//   outcome  stored on the heartbeat row's last_outcome (left unchanged if absent).
//   status   the HTTP status; defaults to 200, or 500 when ok is false.
//   stamp    false: a clean run that must NOT stamp the job's own row. For an
//            hourly tick where no studio was at its daily slot (the row keeps
//            its daily clock), or a job whose row another job stamps. The
//            answer is still success; ignored when ok is false.
//   arms     [{ heartbeat, outcome? }]: the ARM rows to stamp for this run
//            (src/lib/cron-arm-health.js). The job lists only the arms whose
//            run was clean by that arm's own rule; the wrapper stamps each one,
//            whatever the parent's ok, and a failed arm stamp is logged, never
//            fatal. So a wrapped job never calls stampHeartbeat itself.
//
// `tests/cron-define-guard.test.js` requires this wrapper for every new job.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logWarn } from '@/lib/log'

/**
 * @typedef {object} CronResult
 * @property {boolean} [ok]
 * @property {Record<string, unknown>} [body]
 * @property {unknown} [outcome]
 * @property {number} [status]
 * @property {boolean} [stamp]  false: clean, but leave the job's own row alone
 * @property {Array<{ heartbeat: string, outcome?: unknown }>} [arms]  arm rows to stamp
 */

/**
 * @param {{ heartbeat: string }} options  the job's cron_heartbeats row name
 * @param {(ctx: { db: import('@/lib/supabase').Db, request: Request }) => Promise<CronResult | void>} run
 * @returns {(request: Request) => Promise<Response>}
 */
export function defineCron(options, run) {
  const heartbeat = options?.heartbeat
  if (typeof heartbeat !== 'string' || !heartbeat) {
    throw new TypeError('defineCron: options.heartbeat must name a cron_heartbeats row')
  }
  if (typeof run !== 'function') throw new TypeError('defineCron: run must be a function')
  const logModule = `cron.${heartbeat}`

  return async function cronHandler(request) {
    const secret = process.env.CRON_SECRET
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    let result
    try {
      result = (await run({ db: createServerClient(), request })) || {}
    } catch (err) {
      logError(logModule, 'run failed', { err })
      return NextResponse.json({ success: false, error: 'Cron run failed' }, { status: 500 })
    }

    const ok = result.ok !== false
    if (ok && result.stamp !== false) {
      try {
        if (result.outcome === undefined) await stampHeartbeat(heartbeat)
        else await stampHeartbeat(heartbeat, result.outcome)
      } catch (err) {
        logWarn(logModule, 'heartbeat failed', { err })
      }
    }
    for (const arm of Array.isArray(result.arms) ? result.arms : []) {
      const armName = arm?.heartbeat
      if (typeof armName !== 'string' || !armName || armName === heartbeat) {
        logWarn(logModule, 'arm heartbeat skipped: no usable name', { arm: armName ?? null })
        continue
      }
      try {
        if (arm.outcome === undefined) await stampHeartbeat(armName)
        else await stampHeartbeat(armName, arm.outcome)
      } catch (err) {
        logWarn(logModule, 'arm heartbeat failed', { arm: armName, err })
      }
    }
    return NextResponse.json({ ...result.body, success: ok }, { status: result.status ?? (ok ? 200 : 500) })
  }
}
