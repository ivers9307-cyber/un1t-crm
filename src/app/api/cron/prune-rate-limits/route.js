import { defineCron } from '@/lib/define-cron'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'prune-rate-limits' }, async ({ db }) => {
  const now = new Date().toISOString()
  const { error, count } = await db
    .from('rate_limit_buckets')
    .delete({ count: 'exact' })
    .lt('expires_at', now)
  if (error) {
    logError('cron.prune-rate-limits', 'prune failed', { err: error })
    return { ok: false, body: { error: 'Prune failed' } }
  }
  return { body: { deleted: count ?? 0 } }
})
