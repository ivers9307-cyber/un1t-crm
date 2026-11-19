// HYROX-TC.3 — nightly Vercel cron. Keeps ~2 weeks of sessions expanded
// ahead of "now" for every active Hyrox block (several Claude calls per
// block, hence the longer maxDuration). Auth: CRON_SECRET.
import { defineCron } from '@/lib/define-cron'
import { runExpandHyroxWeeks } from '@/lib/hyrox/expand-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const GET = defineCron({ heartbeat: 'expand-hyrox-weeks' }, async ({ db }) => {
  const stats = await runExpandHyroxWeeks(db)
  return { body: { stats } }
})
