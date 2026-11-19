// HYROX-MOBILE (Batch D) — Vercel cron, every 5 min. Reminds the coach(es) on
// shift for each imminent HYROX class to review the workout ~30 min before it
// starts. Auth: CRON_SECRET.
import { defineCron } from '@/lib/define-cron'
import { runHyroxClassReminder } from '@/lib/hyrox/reminder-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'hyrox-class-reminder' }, async ({ db }) => {
  const stats = await runHyroxClassReminder(db)
  return { body: { stats } }
})
