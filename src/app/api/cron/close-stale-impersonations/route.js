// Vercel cron — close stale impersonation sessions (hourly).
//
// impersonation_log rows are closed by an explicit Stop or a re-target.
// Everything else (tab close, logout, cookie/SecureStore expiry) leaves
// the row open forever, which misrepresents a short debug session as
// "still ongoing" in the staff-visible access history. This reaper
// stamps a truthful upper-bound ended_at + auto_closed=true on any row
// open past the session max-age (src/lib/impersonation.js).
//
// Auth: same fail-closed CRON_SECRET pattern as the other crons.

import { defineCron } from '@/lib/define-cron'
import { logError, logWarn } from '@/lib/log'
import { closeStaleImpersonations } from '@/lib/impersonation'
import { closeStaleSupportSessions } from '@/lib/support-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const maxDuration = 60

export const GET = defineCron({ heartbeat: 'close-stale-impersonations' }, async ({ db }) => {
  const result = await closeStaleImpersonations(db)
  if (!result.ok) {
    logError('cron.close-stale-impersonations', 'impersonation sweep failed', { error: result.error })
    return { ok: false, body: { error: 'Impersonation sweep failed' } }
  }
  // SUPPORT-ACCESS (Repset Phase 3) — the same reaper closes stale
  // support_sessions rows (mig 431) at the shared session max-age. A
  // failure here is logged but does NOT fail the cron (the impersonation
  // sweep already succeeded + will heartbeat).
  const support = await closeStaleSupportSessions(db)
  if (!support.ok) {
    logWarn('cron.close-stale-impersonations', 'support session sweep failed', { error: support.error })
  }
  return {
    body: {
      stale: result.stale,
      closed: result.closed,
      support: { stale: support.stale, closed: support.closed },
    },
  }
})
