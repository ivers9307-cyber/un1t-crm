// GAPS-P5 — nightly repeat-bounce escalation sweep.
//
// Thin wrapper: the decision is pure (src/lib/bounce-escalation.js) and the
// I/O is one runner (src/lib/bounce-escalation-sweep.js), so everything worth
// testing is testable without a request.
//
// A contact is escalated only when they bounced across 3+ DISTINCT campaigns
// and no send has ever reached them. That stamps contacts.email_suppressed_at
// (mig 395) — the same column the engagement sweep uses and the same one every
// marketing send already filters on — and writes an email_bounce_escalations
// row (mig 515) recording the count, the campaigns and the delivery history
// that produced the decision. Repeat bouncers who HAVE been delivered to are
// recorded as `review` and never acted on.
//
// Runs at 05:45 UTC, half an hour after email-engagement-sweep, so the two
// crons never contend for the same stamp on the same contact.
//
// ?dry=1 decides everything and writes nothing.

// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// A run with any error (a whole-run abort or a failed write) answers 500 with
// a fixed line and the counts, no stamp; the error text is logged by the
// sweep, never answered.

import { defineCron } from '@/lib/define-cron'
import { runRepeatBounceSweep } from '@/lib/bounce-escalation-sweep'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request) { return GET(request) }

export const GET = defineCron({ heartbeat: 'repeat-bounce-sweep' }, async ({ db, request }) => {
  const dry = new URL(request.url).searchParams.get('dry') === '1'
  const result = await runRepeatBounceSweep({ db, dry })

  // Heartbeat on a clean run only — a sweep that half-failed should read as
  // stale rather than quietly healthy. A dry run is a manual probe, not the
  // scheduled work, so it never stamps either.
  if (!result.ok) {
    const { errors = [], ...counts } = result
    return { ok: false, body: { ...counts, error: 'Repeat-bounce sweep failed', errorCount: errors.length } }
  }
  return { stamp: !dry, outcome: result, body: result }
})
