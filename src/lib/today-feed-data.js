// TODAY-FEED.1 — IO + permission gating for the "Needs attention"
// triage feed on /dashboard/today. Fetches every source the viewer is
// allowed to see, in parallel, and hands the bundle to the pure
// assembler in shared/today-feed.js. Contract with the assembler:
// `null` = source unavailable (no permission / no creds / fetch
// failed), value = fetched. Every source is individually fail-soft —
// one broken query can never take the Today page down.
//
// Web-only on purpose (imports src/lib permission + domain helpers,
// which the mobile bundle can't reach). Mobile reuses the pure
// shared/today-feed.js shaping with its own fetchers when the feed
// lands there (parity program).

import { hasPermission } from '@/lib/permissions'
import { getPendingApprovalsCount } from '@/lib/approvals/registry'
import { countInboxIssues } from '@/lib/issues'
import { loadRadar } from '@/lib/churn-radar-data'
import { radarAvailability } from '@/lib/radar-availability'
import { needsAction } from '@/lib/inbox-queues'
import { formatInZone, getLocationZone, todayStrIn } from '@/lib/location-time'
import { displayZoneFor } from '@/lib/display-zone'
import {
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
  fetchUpcomingEvents,
} from '@/lib/glofox'
import {
  classifyLowFillClasses,
  churnSnapshotDelta,
  filterTasksDueToday,
  assembleTodayFeed,
} from '@shared/today-feed'

// Mirrors the PENDING_STATUSES const in
// src/app/api/invoices-inbox/unread-count/route.js (the sidebar badge)
// so the feed row and the badge always agree on "awaiting action".
const INVOICE_PENDING_STATUSES = ['received', 'extracted']

// How far ahead to ask Glofox for today's classes. Evening classes end
// ~21:30, so a 14h window from a morning page-load covers the day
// without needing timezone-exact end-of-day math.
const CLASS_WINDOW_HOURS = 14

// TZ.17 — "today" (bookings today, tasks due) is the studio's calendar day.
// It used to be the host clock's (UTC on Vercel), so from 00:00 to 01:00 Irish
// summer time the feed still showed yesterday's bookings and tasks.
// `zoneP` is a promise of the studio zone; a rejection makes each row that
// needs the day null (omitted), never a guessed day.
async function todayIn(zoneP, nowMs) {
  return todayStrIn(await zoneP, nowMs)
}

// One zone read per feed, shared by every row that needs it. The rejection is
// observed here so an unused failed read is never an unhandled rejection.
function lazyZone(read) {
  let p = null
  return () => {
    if (!p) { p = Promise.resolve().then(read); p.catch(() => {}) }
    return p
  }
}

// Wrap a fetcher: permission off → null; throw/reject → null.
async function safe(allowed, fn) {
  if (!allowed) return null
  try {
    return await fn()
  } catch {
    return null
  }
}

// HOME.3 — unified with the shared needsAction predicate
// (src/lib/inbox-queues.js), the same one the Communications badge
// (/api/whatsapp/unread-count) and the home queue (src/lib/home-queue.js)
// count by. This used to sum raw unread_count, which is exactly the bug
// SIDEBAR-BADGES.2 fixed for the nav badge: it reads 0 the instant someone
// opens a thread without replying or resolving it, and it never saw an
// agent handoff whose last line was Mia's own holding message. Without this
// fix the Today feed's WhatsApp row and the badge right next to it on the
// same page could show two different numbers for the same inbox.
//
// NOTE for the morning-briefing digest (BRIEFING.1 / fetchLocationTodayFeed
// below): this row's WA number changed semantics from "unread messages" to
// "threads needing a reply or handoff" — a smaller, more meaningful number,
// not a regression if today's email reads lower than yesterday's.
async function fetchWhatsappNeedsAction(db, locationId) {
  const cols = 'resolved_at, last_message_at, last_message_direction, agent_handed_off_at'
  const { data, error } = await db
    .from('whatsapp_conversations')
    .select(cols)
    .eq('location_id', locationId)
    .is('resolved_at', null)
  if (error) return null
  return (data || []).filter(needsAction).length
}

async function fetchInvoicesPending(db, locationId) {
  const { count, error } = await db
    .from('invoices_queue')
    .select('*', { count: 'exact', head: true })
    .in('status', INVOICE_PENDING_STATUSES)
    .eq('location_id', locationId)
  if (error) return null
  return count || 0
}

async function fetchBookingsToday(db, locationId, todayIso) {
  const { data, error } = await db
    .from('bookings')
    .select('start_time, status, event_types(name)')
    .eq('location_id', locationId)
    .eq('booking_date', todayIso)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true })
  if (error) return null
  const rows = data || []
  const next = rows[0]
  return {
    count: rows.length,
    nextLabel: next
      ? `${(next.start_time || '').slice(0, 5)} ${next.event_types?.name || ''}`.trim()
      : null,
  }
}

async function fetchChurn(db, locationId) {
  // UN1TRADAR.1 — no churn row at a source without membership data
  const avail = await radarAvailability(db, locationId, { module: 'today-feed' })
  if (!avail.available) return null
  const [{ radar, summary }, snapshotRes] = await Promise.all([
    loadRadar(db, locationId),
    db
      .from('churn_radar_snapshots')
      .select('high_risk, captured_at')
      .eq('location_id', locationId)
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const highRisk = summary?.highRisk || 0
  const { delta, sinceIso } = churnSnapshotDelta(highRisk, snapshotRes?.data || null)
  return {
    highRisk,
    delta,
    sinceIso,
    topMembers: (radar || [])
      .filter((r) => r.tier === 'high')
      .slice(0, 3)
      .map((r) => r.name),
  }
}

async function fetchTasksDue(db, locationId, todayIso) {
  // Contact-scoped tasks often carry no location_id (the column is
  // optional on insert), so a strict location filter would hide them —
  // include location-less tasks at every location instead.
  const { data, error } = await db
    .from('activities')
    .select('subject, note, due_date, kind, done')
    .eq('kind', 'task')
    .eq('done', false)
    .lte('due_date', todayIso)
    .or(`location_id.eq.${locationId},location_id.is.null`)
    .order('due_date', { ascending: true })
    .limit(10)
  if (error) return null
  return filterTasksDueToday(data || [], todayIso)
}

/**
 * TZ.11a — a low-fill class's start time, 'HH:MM' on the STUDIO's clock (the
 * same en-IE 2-digit options the Dublin label used, so Dublin is unchanged).
 */
export function lowFillTimeLabel(timeStartMs, zone) {
  return formatInZone(timeStartMs, zone, { hour: '2-digit', minute: '2-digit' }, 'en-IE')
}

// `zoneFor` resolves the studio's zone only when there is a class to label; a
// rejection makes this source null (the row is omitted), never a guessed zone.
async function fetchLowFillClasses(db, locationId, nowMs, zoneFor) {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds || missingGlofoxCredentialsForLocation(creds).length) return null
  const start = Math.floor(nowMs / 1000)
  const { ok, events } = await fetchUpcomingEvents(creds, {
    start,
    end: start + CLASS_WINDOW_HOURS * 3600,
    limit: 100,
  })
  if (!ok) return null
  const classes = classifyLowFillClasses(events, nowMs)
  if (!classes.length) return classes
  const zone = await zoneFor()
  return classes.map((c) => ({ ...c, timeLabel: lowFillTimeLabel(c.timeStartMs, zone) }))
}

/**
 * BRIEFING.1 — location-level feed for the morning-briefing cron.
 * No viewer to gate by, so every location-scoped source is fetched;
 * the approvals row is deliberately ABSENT (the approvals registry is
 * per-user scoped — providers fan out on the caller's approvable
 * locations — and faking a user object there is fragile; the Today
 * page covers approvals per-viewer). Same fail-soft contract as
 * fetchTodayFeed. TZ.11a: the low-fill labels are the studio's clock
 * (`zone`, or read here); this feed goes out in an email, so an unreadable
 * zone omits that one row rather than label it on a guessed zone.
 */
export async function fetchLocationTodayFeed(db, locationId, nowMs = Date.now(), { zone } = {}) {
  if (!locationId) return []
  const zoneFor = lazyZone(() => zone || getLocationZone(db, locationId))
  const [issues, invoices, whatsappUnread, bookingsToday, churn, tasksDue, lowFill] =
    await Promise.all([
      safe(true, () => countInboxIssues(db, locationId)),
      safe(true, () => fetchInvoicesPending(db, locationId)),
      safe(true, () => fetchWhatsappNeedsAction(db, locationId)),
      safe(true, async () => fetchBookingsToday(db, locationId, await todayIn(zoneFor(), nowMs))),
      safe(true, () => fetchChurn(db, locationId)),
      safe(true, async () => fetchTasksDue(db, locationId, await todayIn(zoneFor(), nowMs))),
      safe(true, () => fetchLowFillClasses(db, locationId, nowMs, zoneFor)),
    ])
  return assembleTodayFeed({
    approvals: null, issues, invoices, whatsappUnread,
    bookingsToday, churn, tasksDue, lowFill,
  })
}

/**
 * Fetch + assemble the viewer's triage rows for the active location.
 * Returns [] when nothing needs attention (the page renders "all
 * clear"); individual sources degrade to omitted rows, never throw.
 *
 * HOME.3 rider (review of the original queue PR) — assembleHomeQueue
 * (src/lib/home-queue.js) now covers approvals/issues/invoices/whatsapp
 * at item level, and the web /dashboard/today page stopped RENDERING
 * this function's rows for those four ids. Left as-is, this function
 * kept COMPUTING them anyway — getPendingApprovalsCount fired once here
 * and once more inside assembleHomeQueue, every page load. `skip` lets a
 * caller who doesn't need certain rows say so up front, same fail-soft
 * contract otherwise. Deliberately a DENYLIST (ids to omit), not an
 * allowlist of ids to compute: a future source added to the Promise.all
 * below is computed by default for every caller unless a caller
 * explicitly names it in `skip` — mirrors the QUEUE_MIGRATED_IDS denylist
 * in dashboard/today/page.js (R2 of the same review), so "what the queue
 * already owns" is the one thing both layers name, rather than either
 * layer having to enumerate "everything else". The mobile
 * /api/mobile/today-feed route calls this with no `skip` (mobile has no
 * item-level queue yet — parity program, still catching up) and gets
 * every source computed, exactly as before this rider.
 */
export async function fetchTodayFeed(db, user, locationId, { nowMs = Date.now(), skip = [], zone } = {}) {
  if (!user || !locationId) return []
  // TZ.11a/TZ.17 — the studio's clock (`zone` from the page, else the active
  // location's row or a cached read; a display fallback, logged).
  const zoneFor = lazyZone(async () => zone || displayZoneFor(db, user, locationId, 'today-feed'))
  const canBookings = hasPermission(user, 'events') || hasPermission(user, 'bookings')
  const want = (id) => !skip.includes(id)

  const [
    approvals, issues, invoices, whatsappUnread,
    bookingsToday, churn, tasksDue, lowFill,
  ] = await Promise.all([
    safe(want('approvals') && hasPermission(user, 'approvals_inbox'), () => getPendingApprovalsCount(db, user)),
    safe(want('issues') && hasPermission(user, 'issues_inbox'), () => countInboxIssues(db, locationId)),
    safe(want('invoices') && hasPermission(user, 'invoices_inbox'), () => fetchInvoicesPending(db, locationId)),
    safe(want('whatsapp') && hasPermission(user, 'whatsapp'), () => fetchWhatsappNeedsAction(db, locationId)),
    safe(want('bookings') && canBookings, async () => fetchBookingsToday(db, locationId, await todayIn(zoneFor(), nowMs))),
    safe(want('churn') && hasPermission(user, 'churn_radar'), () => fetchChurn(db, locationId)),
    safe(want('tasks') && hasPermission(user, 'activities'), async () => fetchTasksDue(db, locationId, await todayIn(zoneFor(), nowMs))),
    safe(want('lowfill') && canBookings, () => fetchLowFillClasses(db, locationId, nowMs, zoneFor)),
  ])

  return assembleTodayFeed({
    approvals, issues, invoices, whatsappUnread,
    bookingsToday, churn, tasksDue, lowFill,
  })
}
