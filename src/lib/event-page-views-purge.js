// HOSTSTATS.1 — retention for event_page_views (mig 821): a row older than
// EVENT_PAGE_VIEWS_RETENTION_DAYS goes. An arm of the daily
// /api/cron/purge-webhook-payloads run, with ITS OWN heartbeat row
// ('purge-event-page-views', mig 822): the parent's row is stamped whatever
// this arm did, and the health check reads only is_stale, so an arm that
// failed every night would otherwise page nobody.
//
// Delete-as-you-go (the parent's idiom): read the oldest PURGE_PAGE ids past
// the cutoff, delete exactly those (the cutoff rides on the delete too), and
// repeat; a short page ends the run, MAX_PAGES bounds it (the backlog drains
// over following nights). A failed read or delete returns ok:false with
// what was deleted so far; nothing here throws.

import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { PURGE_EVENT_PAGE_VIEWS_HEARTBEAT } from '@/lib/cron-arm-health'
import { logWarn } from '@/lib/log'

export const EVENT_PAGE_VIEWS_RETENTION_DAYS = 180
export const PURGE_PAGE = 500
const MAX_PAGES = 20

export function eventPageViewsCutoff(nowMs = Date.now()) {
  return new Date(nowMs - EVENT_PAGE_VIEWS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export async function purgeEventPageViews(db, { nowMs = Date.now() } = {}) {
  const cutoff = eventPageViewsCutoff(nowMs)
  let deleted = 0
  let pages = 0
  for (;;) {
    if (pages >= MAX_PAGES) return { ok: true, deleted, pages, cutoff, capped: true }
    const { data, error } = await db
      .from('event_page_views')
      .select('id')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .range(0, PURGE_PAGE - 1)
    if (error) return { ok: false, error, deleted, pages, cutoff }
    const ids = (Array.isArray(data) ? data : []).map((r) => r.id)
    if (ids.length === 0) break
    const { error: delErr } = await db.from('event_page_views').delete().in('id', ids).lt('created_at', cutoff)
    if (delErr) return { ok: false, error: delErr, deleted, pages, cutoff }
    deleted += ids.length
    pages += 1
    if (ids.length < PURGE_PAGE) break
  }
  return { ok: true, deleted, pages, cutoff }
}

/** The arm as the parent cron calls it: run, then stamp our own row only on a clean run. */
export async function runEventPageViewsPurgeArm(db, opts = {}) {
  const result = await purgeEventPageViews(db, opts)
  if (result.ok) {
    try {
      await stampHeartbeat(PURGE_EVENT_PAGE_VIEWS_HEARTBEAT, { deleted: result.deleted, pages: result.pages, cutoff: result.cutoff, capped: result.capped === true })
    } catch (err) {
      logWarn('cron.purge-event-page-views', 'heartbeat stamp failed', { err })
    }
  } else {
    logWarn('cron.purge-event-page-views', 'purge failed; not stamping', { err: result.error, deleted: result.deleted, pages: result.pages })
  }
  return result
}
