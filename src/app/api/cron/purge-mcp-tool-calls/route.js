import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** How long a staff MCP call-log row is kept. The MCP.1 spec promises 90 days. */
export const RETENTION_DAYS = 90
/**
 * Rows per page. The candidate read is `select id` only, so a page is a few KB;
 * 500 keeps each DELETE's `IN (…)` list short.
 */
export const PURGE_PAGE_SIZE = 500
/** Runaway guard: 10,000 rows per tick; any backlog drains over the next days. */
const MAX_PAGES = 20

const TABLE = 'mcp_tool_calls'

/** ISO cutoff: any call logged before this is past retention. */
export function retentionCutoff(nowMs = Date.now()) {
  return new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * GET /api/cron/purge-mcp-tool-calls — MCP.1 call-log retention.
 *
 * public.mcp_tool_calls (mig 801) records who called which MCP tool, from which
 * OAuth client, and whether it worked: no arguments, no results. It is still a
 * record of what each person did, so it does not grow for ever: a row is
 * deleted RETENTION_DAYS after `created_at`.
 *
 * PAGING: delete-as-you-go, the same shape as purge-webhook-payloads. Each
 * iteration reads the OLDEST PURGE_PAGE_SIZE ids past the cutoff with
 * .range(0, n-1) ordered by created_at; once that page is deleted the next
 * oldest rows move into range 0, so the cursor never advances and never skips.
 * A short page ends the run; MAX_PAGES bounds it. The cutoff predicate rides
 * along on every delete as belt and braces.
 *
 * FAILURE: a failed scan or delete answers 500 and does NOT stamp the
 * heartbeat: a purge that silently is not purging shows up only as a table
 * that keeps growing. An idle run (nothing past retention) DOES stamp: the
 * cron ran and was right to do nothing.
 *
 * Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).
 * Heartbeat row ships with mig 802, applied right after this code deploys;
 * vercel.json 04:35 UTC.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const cutoff = retentionCutoff(Date.now())

  let deleted = 0
  let pages = 0
  let capReached = false

  for (;;) {
    if (pages >= MAX_PAGES) { capReached = true; break }

    const { data: rows, error: scanErr } = await db.from(TABLE)
      .select('id')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .range(0, PURGE_PAGE_SIZE - 1)
    if (scanErr) {
      return fail('candidate scan failed', scanErr, { cutoff, deleted, pages })
    }
    const ids = (rows || []).map(r => r?.id).filter(id => id !== null && id !== undefined)
    if (ids.length === 0) break
    pages += 1

    // `.select('id')` so the count is rows REMOVED, not rows requested; a
    // delete that removes nothing ends the loop instead of re-reading the same
    // page MAX_PAGES times and reporting deletions that never happened.
    const { data: gone, error: delErr } = await db.from(TABLE)
      .delete()
      .lt('created_at', cutoff)
      .in('id', ids)
      .select('id')
    if (delErr) {
      return fail('delete failed', delErr, { cutoff, deleted, pages })
    }
    const removed = Array.isArray(gone) ? gone.length : 0
    deleted += removed
    if (removed === 0) break

    if (ids.length < PURGE_PAGE_SIZE) break
  }

  const outcome = { cutoff, deleted }
  logInfo('cron.purge-mcp-tool-calls', 'run complete', { ...outcome, retention_days: RETENTION_DAYS, pages, cap_reached: capReached })
  await stampHeartbeat('purge-mcp-tool-calls', outcome)
  return NextResponse.json({ success: true, data: { ...outcome, retention_days: RETENTION_DAYS, pages, cap_reached: capReached } })
}

function fail(what, err, progress) {
  logError('cron.purge-mcp-tool-calls', `${what} — not stamping`, { err: err.message, ...progress })
  return NextResponse.json({
    success: false,
    error: `purge failed: ${what}: ${err.message}`,
    data: progress,
  }, { status: 500 })
}
