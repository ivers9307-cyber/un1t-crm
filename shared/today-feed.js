// TODAY-FEED.1 — pure logic for the "Needs attention" triage feed on
// /dashboard/today. Lives in shared/ (not src/lib) so the mobile
// PersonalDashboard and the future morning-briefing digest can reuse
// the exact same shaping: every function here is (raw data, now) →
// data, no IO, no permissions. The web IO + permission gating lives in
// src/lib/today-feed-data.js, which feeds assembleTodayFeed() a bundle
// where `null` means "source unavailable" (no permission, no creds, or
// the fetch failed) and a number/array means "fetched".

// A class under this fraction of capacity counts as low-fill. 0.5 was
// picked with Richard 2026-06-12 as a v1 heuristic — tune freely.
export const LOW_FILL_THRESHOLD = 0.5

/**
 * Filter a Glofox /2.0/events list down to upcoming, public, active
 * classes under the fill threshold. Pure: caller supplies nowMs.
 * Glofox time_start is unix SECONDS (verified live — fetchUpcomingEvents).
 * Zero/absent `size` rows are skipped — no meaningful fill math.
 */
export function classifyLowFillClasses(events, nowMs, threshold = LOW_FILL_THRESHOLD) {
  const out = []
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    if (e.active === false || e.private === true) continue
    const size = Number(e.size)
    if (!Number.isFinite(size) || size <= 0) continue
    const startMs = Number(e.time_start) * 1000
    if (!Number.isFinite(startMs) || startMs <= nowMs) continue
    const booked = Number(e.booked) || 0
    if (booked / size >= threshold) continue
    out.push({
      id: e._id || e.id || null,
      name: e.name || 'Class',
      timeStartMs: startMs,
      booked,
      size,
      fillPct: Math.round((booked / size) * 100),
    })
  }
  out.sort((a, b) => a.timeStartMs - b.timeStartMs)
  return out
}

/**
 * Compare the live high-risk count against the most recent
 * churn_radar_snapshots row (the snapshot cron is weekly, so this is
 * "since last Monday", not "since yesterday" — label accordingly).
 * Returns { delta, sinceIso } with nulls when no usable snapshot.
 */
export function churnSnapshotDelta(currentHighRisk, previous) {
  const prev = previous && Number.isFinite(Number(previous.high_risk))
    ? Number(previous.high_risk)
    : null
  if (prev === null) return { delta: null, sinceIso: null }
  return {
    delta: Number(currentHighRisk || 0) - prev,
    sinceIso: previous.created_at || null,
  }
}

/**
 * Open tasks due today or earlier, oldest due first. `tasks` are
 * activities rows (kind task|event, done boolean, due_date ISO date).
 */
export function filterTasksDueToday(tasks, todayIso) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.kind === 'task' && !t.done && t.due_date && t.due_date <= todayIso)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
}

const MAX_ROW_ITEMS = 3

/**
 * Shape the fetched bundle into ordered feed rows. Contract:
 *   - a bundle field of `null`/`undefined` → source unavailable → row omitted
 *   - a zero count / empty list → nothing to act on → row omitted
 *     (the UI renders "all clear" when no rows survive)
 * Row shape: { id, label, count, detail?, items?: [{label, sublabel?}], href }
 * Order = triage priority: the four action queues, then today's
 * bookings, then the watchers (churn / tasks / low-fill).
 */
export function assembleTodayFeed(bundle = {}) {
  const rows = []
  const {
    approvals, issues, invoices, whatsappUnread,
    bookingsToday, churn, tasksDue, lowFill,
  } = bundle

  const queue = (id, value, label, href) => {
    if (value === null || value === undefined || value <= 0) return
    rows.push({ id, label, count: value, href })
  }
  queue('approvals', approvals, 'Approvals waiting', '/approvals')
  queue('issues', issues, 'Open issues', '/issues')
  queue('invoices', invoices, 'Invoices to process', '/invoices')
  queue('whatsapp', whatsappUnread, 'Unread WhatsApp messages', '/communications/inbox')

  if (bookingsToday && (bookingsToday.count || 0) > 0) {
    rows.push({
      id: 'bookings',
      label: 'Bookings today',
      count: bookingsToday.count,
      detail: bookingsToday.nextLabel ? `next: ${bookingsToday.nextLabel}` : undefined,
      href: '/bookings',
    })
  }

  if (churn && (churn.highRisk || 0) > 0) {
    const dir = churn.delta > 0 ? '▲' : churn.delta < 0 ? '▼' : null
    rows.push({
      id: 'churn',
      label: 'High-risk members',
      count: churn.highRisk,
      detail: dir && churn.delta !== 0
        ? `${dir} ${Math.abs(churn.delta)} since last snapshot`
        : undefined,
      items: (churn.topMembers || []).slice(0, MAX_ROW_ITEMS).map((m) => ({ label: m })),
      href: '/dashboard/churn-radar',
    })
  }

  if (Array.isArray(tasksDue) && tasksDue.length > 0) {
    rows.push({
      id: 'tasks',
      label: 'Tasks due',
      count: tasksDue.length,
      items: tasksDue.slice(0, MAX_ROW_ITEMS).map((t) => ({
        label: t.subject || t.note || 'Task',
        sublabel: t.due_date,
      })),
      href: '/activities',
    })
  }

  if (Array.isArray(lowFill) && lowFill.length > 0) {
    rows.push({
      id: 'lowfill',
      label: 'Low-fill classes today',
      count: lowFill.length,
      items: lowFill.slice(0, MAX_ROW_ITEMS).map((c) => ({
        label: c.name,
        sublabel: `${c.timeLabel || ''} · ${c.booked}/${c.size} booked`.replace(/^ · /, ''),
      })),
      href: '/communications/inbox',
    })
  }

  return rows
}
