import { defineCron } from '@/lib/define-cron'
import { runAgentReview } from '@/lib/agent/review'

// MIA-BOARD.4 — nightly at 03:00 (vercel.json): rubric-review yesterday's
// agent-touched conversations into agent_conversation_reviews (mig 569).
// Reruns are idempotent (unique (channel, conversation_id, review_date)).
// Mondays additionally push managers the 7-day flagged digest.
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'agent-review' }, async ({ db }) => {
  const results = await runAgentReview(db)
  return { body: { results }, outcome: results }
})
