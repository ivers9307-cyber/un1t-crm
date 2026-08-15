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
import { needsAction } from '@/lib/inbox-queues'
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

function isoToday(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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

async function fetchLowFillClasses(db, locationId, nowMs) {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds || missingGlofoxCredentialsForLocation(creds).length) return null
  const start = Math.floor(nowMs / 1000)
  const { ok, events } = await fetchUpcomingEvents(creds, {
    start,
    end: start + CLASS_WINDOW_HOURS * 3600,
    limit: 100,
  })
  if (!ok) return null
  return classifyLowFillClasses(events, nowMs).map((c) => ({
    ...c,
    timeLabel: new Date(c.timeStartMs).toLocaleTimeString('en-IE', {
      timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
    }),
  }))
}

/**
 * BRIEFING.1 — location-level feed for the morning-briefing cron.
 * No viewer to gate by, so every location-scoped source is fetched;
 * the approvals row is deliberately ABSENT (the approvals registry is
 * per-user scoped — providers fan out on the caller's approvable
 * locations — and faking a user object there is fragile; the Today
 * page covers approvals per-viewer). Same fail-soft contract as
 * fetchTodayFeed.
 */
export async function fetchLocationTodayFeed(db, locationId, nowMs = Date.now()) {
  if (!locationId) return []
  const todayIso = isoToday(new Date(nowMs))
  const [issues, invoices, whatsappUnread, bookingsToday, churn, tasksDue, lowFill] =
    await Promise.all([
      safe(true, () => countInboxIssues(db, locationId)),
      safe(true, () => fetchInvoicesPending(db, locationId)),
      safe(true, () => fetchWhatsappNeedsAction(db, locationId)),
      safe(true, () => fetchBookingsToday(db, locationId, todayIso)),
      safe(true, () => fetchChurn(db, locationId)),
      safe(true, () => fetchTasksDue(db, locationId, todayIso)),
      safe(true, () => fetchLowFillClasses(db, locationId, nowMs)),
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
 */
export async function fetchTodayFeed(db, user, locationId, nowMs = Date.now()) {
  if (!user || !locationId) return []
  const todayIso = isoToday(new Date(nowMs))
  const canBookings = hasPermission(user, 'events') || hasPermission(user, 'bookings')

  const [
    approvals, issues, invoices, whatsappUnread,
    bookingsToday, churn, tasksDue, lowFill,
  ] = await Promise.all([
    safe(hasPermission(user, 'approvals_inbox'), () => getPendingApprovalsCount(db, user)),
    safe(hasPermission(user, 'issues_inbox'), () => countInboxIssues(db, locationId)),
    safe(hasPermission(user, 'invoices_inbox'), () => fetchInvoicesPending(db, locationId)),
    safe(hasPermission(user, 'whatsapp'), () => fetchWhatsappNeedsAction(db, locationId)),
    safe(canBookings, () => fetchBookingsToday(db, locationId, todayIso)),
    safe(hasPermission(user, 'churn_radar'), () => fetchChurn(db, locationId)),
    safe(hasPermission(user, 'activities'), () => fetchTasksDue(db, locationId, todayIso)),
    safe(canBookings, () => fetchLowFillClasses(db, locationId, nowMs)),
  ])

  return assembleTodayFeed({
    approvals, issues, invoices, whatsappUnread,
    bookingsToday, churn, tasksDue, lowFill,
  })
}
