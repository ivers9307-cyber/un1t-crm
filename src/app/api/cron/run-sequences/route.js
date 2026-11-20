// Vercel cron — every 5 minutes.
// Picks up due sequence enrollments and fires the next step.
//
// defineCron owns the CRON_SECRET check (Vercel sends it as a bearer; a local
// call through the dev server needs the same bearer), the error boundary and
// the 'run-sequences' stamp. The stamp means runSequences() completed: a throw
// from it answers 500 with a fixed error and no stamp (the detail is logged).
// A trigger phase dying wholesale is reported in its *_error field (fixed
// text; the detail is logged) and never costs the tick its stamp.

import { defineCron } from '@/lib/define-cron'
import {
  runSequences,
  runEventReminderTriggers,
  runAnniversaryTriggers,
  runInactivityTriggers,
  runAudienceMatchTriggers,
} from '@/lib/sequences'
import { runEventReminderSends } from '@/lib/event-reminders'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Pro ceiling. Three phases run sequentially per tick
// (event-reminder sends, event_reminder triggers, runSequences).
// Each batches internally (PROCESS_BATCH_SIZE = 100 in
// sequences.js), but a busy 5-min window with hundreds of due
// enrollments + reminders can exceed the Pro default. 300s gives
// plenty of headroom.
export const maxDuration = 300

const LOG_MODULE = 'cron-run-sequences'
const PHASE_FAILED = 'phase failed'

/** Run one best-effort phase: its stats, or null and a fixed error (detail logged). */
async function phase(name, run) {
  try {
    return { stats: await run(), error: null }
  } catch (err) {
    logWarn(LOG_MODULE, `${name} failed`, { err })
    return { stats: null, error: PHASE_FAILED }
  }
}

export const GET = defineCron({ heartbeat: 'run-sequences' }, async () => {
  // Three phases per tick — each independent so a failure in one
  // doesn't stop the others:
  //   1. event-level reminder sends (mig 044)
  //      Single-shot reminders attached to event_types. Cheapest path
  //      for "send a WhatsApp 24h before each booking" without an
  //      operator authoring a sequence.
  //   2. sequence event_reminder triggers
  //      Multi-step reminder flows configured as sequences.
  //   3. runSequences()
  //      Pick up due enrolments and send the next step.
  const reminderSends = await phase('event-reminder sends', runEventReminderSends)
  const triggers = await phase('event_reminder triggers', runEventReminderTriggers)

  // Tier 2A — anniversary + inactivity triggers (mig 088 follow-up).
  // Run alongside the existing event_reminder scan. Both are
  // independent + best-effort.
  const anniversary = await phase('anniversary triggers', runAnniversaryTriggers)
  // AUDIENCEMATCH.1 — sweep audience_match sequences BEFORE runSequences, so a
  // contact enrolled this tick is picked up by the runner in the same tick
  // rather than waiting five minutes for the next one. Independent + best
  // effort like its siblings: a failure here must never stop due enrolments
  // from being processed below.
  const audience = await phase('audience_match triggers', runAudienceMatchTriggers)
  const inactivity = await phase('inactivity triggers', runInactivityTriggers)

  let stats
  try {
    stats = await runSequences()
  } catch (err) {
    // No stamp: that's the signal a downstream alert needs.
    logError(LOG_MODULE, 'runSequences failed', { err })
    return { ok: false, body: { error: 'Sequence run failed' } }
  }

  // CRONISO.1 — the trigger runners no longer abort their whole sweep when
  // one sequence fails; they contain it and count it. The *_error fields only
  // ever caught a runner dying wholesale, so a single broken sequence looked
  // like a clean tick. Surface the per-runner counts as one number the cron
  // response leads with.
  const triggerErrors =
    (triggers.stats?.errored || 0) +
    (anniversary.stats?.errored || 0) +
    (inactivity.stats?.errored || 0) +
    (audience.stats?.errored || 0)
  return {
    body: {
      // Non-zero means N individual sequences did nothing this tick —
      // each one logged with its id via logError('sequences', …).
      trigger_errors: triggerErrors,
      stats,
      triggers: triggers.stats,
      trigger_error: triggers.error,
      anniversary: anniversary.stats,
      anniversary_error: anniversary.error,
      inactivity: inactivity.stats,
      inactivity_error: inactivity.error,
      audience_match: audience.stats,
      audience_match_error: audience.error,
      reminder_sends: reminderSends.stats,
      reminder_sends_error: reminderSends.error,
    },
  }
})
