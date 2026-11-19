// HYROX-TC.3 — Vercel cron, every 5 min. Reconciles each active Hyrox
// block's target TV(s) to the current live class's approved board.
// Auth: CRON_SECRET.
import { defineCron } from '@/lib/define-cron'
import { runPublishHyroxBoard } from '@/lib/hyrox/publish-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'publish-hyrox-board' }, async ({ db }) => {
  const stats = await runPublishHyroxBoard(db)
  return { body: { stats } }
})
