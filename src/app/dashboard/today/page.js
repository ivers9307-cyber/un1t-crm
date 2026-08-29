// /dashboard/today — Personal dashboard. Web mirror of the mobile
// PersonalDashboard. Same data fetched from shared/dashboard-data.js.
//
// TODAY-FEED.1 made this the gym's front door: a permission-filtered
// "Needs attention" triage feed rendering above the personal roster,
// each row deep-linking into its full surface.
//
// HOME.3 replaced the count-level rows for approvals / email /
// unified inbox with assembleHomeQueue's item-level merged queue (src/
// lib/home-queue.js) — one row per approval / ticket / conversation,
// not one row per source count. The today-feed rows that are NOT queue
// sources (today's bookings, churn watch, tasks due, low-fill classes)
// still render, in their own block below the queue (QUEUE_MIGRATED_IDS
// names the ids the queue owns; everything else renders).
//
// Permission: dashboard_personal (cross-platform).

import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  Calendar, AlertCircle, AlertTriangle, ClipboardCheck, Inbox, MessagesSquare,
  Radar, CheckSquare, Flag, Mail, Receipt, FileText, Wallet, Zap,
  ArrowLeftRight, Users, Handshake, ShoppingBag,
} from 'lucide-react'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import {
  fetchPersonalDashboardData,
  fetchUnstaffedBlocksThisWeek,
  fetchIncompletePayProfiles,
  fetchPendingRosterApprovalsCount,
} from '@shared/dashboard-data'
import { buildMonthMatrix } from '@shared/roster-month'
import { MANAGER_ROLES } from '@/lib/schemas'
import { fetchTodayFeed } from '@/lib/today-feed-data'
import { assembleHomeQueue, queueCountLabel, groupQueueRows } from '@/lib/home-queue'
import { relativeTime } from '@/lib/ticket-display'
import {
  KpiCard, KpiRow, SectionHeader, ListCard, PendingRow,
} from '@/components/dashboard/Cards'
import MonthRoster from '@/components/dashboard/MonthRoster'
import MyRequests from '@/components/dashboard/MyRequests'
import SwapActions from '@/components/dashboard/SwapActions'

// Icon per triage row id (assembleTodayFeed in shared/today-feed.js owns
// the ids). Kept here — icons are a web rendering concern. HOME.3 —
// 'approvals', 'issues', 'invoices' and 'whatsapp' no longer render from
// this map (those sources moved to the item-level queue below); the
// entries stay so a future today-feed row of the same id doesn't need a
// new icon decision.
const FEED_ICONS = {
  approvals: <ClipboardCheck size={16} />,
  issues: <AlertCircle size={16} />,
  invoices: <Inbox size={16} />,
  whatsapp: <MessagesSquare size={16} />,
  bookings: <Calendar size={16} />,
  churn: <Radar size={16} />,
  tasks: <CheckSquare size={16} />,
  lowfill: <Flag size={16} />,
}

// HOME.3's assembleHomeQueue (src/lib/home-queue.js) covers approvals
// (which already folds in the issues + invoices-queue approval
// providers) and the unified inbox (which already covers whatsapp) at
// item level, so the matching today-feed rows would just duplicate the
// queue above — these four ids are the ones the queue now owns.
//
// R2 (HOME.3 review rider) — this used to be SECONDARY_FEED_IDS, an
// ALLOWLIST of the four ids that still render below the queue
// ('bookings', 'churn', 'tasks', 'lowfill'). That silently drops any
// today-feed source added later: shared/today-feed.js's assembler
// gains a 9th row id, nobody remembers to add it here, and it renders
// nowhere — present in feedRows, invisible on the page. Inverted to a
// DENYLIST of what the queue owns: a future non-migrated source is
// VISIBLE by default because it simply isn't in this list, no edit
// needed. Same constant also passed as fetchTodayFeed's `skip` option
// below (R1) — the two are intentionally the same list, since "what the
// queue already computed" is one fact, not two.
const QUEUE_MIGRATED_IDS = ['approvals', 'issues', 'invoices', 'whatsapp']

// One line of context under a feed row: the detail string (e.g. the
// churn delta) followed by up to three item labels.
function feedSubtitle(row) {
  const items = (row.items || []).map((it) =>
    it.sublabel ? `${it.label} (${it.sublabel})` : it.label)
  return [row.detail, ...items].filter(Boolean).join(' · ') || undefined
}

// Icon per home-queue row source. Mail and inbox map directly; every
// approvals provider key (src/lib/approvals/providers/*.js) gets its own
// icon so the flat/grouped queue list doesn't render one generic glyph
// for eleven very different kinds of approval. Falls back to the generic
// approvals icon for any provider key added later without an update here.
const QUEUE_SOURCE_ICONS = {
  issues: <AlertCircle size={16} />,
  invoices_queue: <Receipt size={16} />,
  contractor_invoices: <FileText size={16} />,
  fte_expenses: <Wallet size={16} />,
  agent_requests: <Zap size={16} />,
  time_off: <Calendar size={16} />,
  shift_swaps: <ArrowLeftRight size={16} />,
  rosters: <ClipboardCheck size={16} />,
  hyrox_sessions: <Users size={16} />,
  host_events: <Handshake size={16} />,
  offer_purchases: <ShoppingBag size={16} />,
  mail: <Mail size={16} />,
  inbox: <MessagesSquare size={16} />,
}
const DEFAULT_QUEUE_ICON = <ClipboardCheck size={16} />

function queueRowIcon(row) {
  return QUEUE_SOURCE_ICONS[row.source] || DEFAULT_QUEUE_ICON
}

// host_events is the one org-wide approval provider (see home-queue.js) —
// flag it in the subtitle so it doesn't read as local to the active
// studio.
function queueRowSubtitle(row) {
  if (!row.orgWide) return row.subtitle || undefined
  return row.subtitle ? `${row.subtitle} · org-wide` : 'org-wide'
}

// Renders one ListCard's worth of queue rows (either the flat list or a
// single group's slice) — isLast is always relative to the array passed
// in, so a grouped section's border logic is self-contained.
function QueueRows({ rows }) {
  return rows.map((row, i) => (
    <PendingRow
      key={`${row.source}-${row.id}`}
      icon={queueRowIcon(row)}
      title={row.title}
      subtitle={queueRowSubtitle(row)}
      time={relativeTime(row.occurredAt)}
      href={row.href}
      isLast={i === rows.length - 1}
    />
  ))
}

export const dynamic = 'force-dynamic'

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default async function PersonalDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Permission gate — toggle is honoured for every role including owner.
  if (!hasPermission(user, 'dashboard_personal')) redirect('/dashboard')

  const db = createServerClient()
  // TODAY-FEED.1 / HOME.3 — the triage feed and the item-level queue
  // fetch in parallel with the personal data; both gate per-source
  // internally and never throw. fetchTodayFeed is still needed for the
  // rows that are NOT home-queue sources (bookings/churn/tasks/lowfill);
  // its approvals/issues/invoices/whatsapp rows are no longer rendered,
  // since assembleHomeQueue now covers those same sources at item level
  // — R1 (HOME.3 review rider) passes `skip: QUEUE_MIGRATED_IDS` so
  // fetchTodayFeed doesn't bother COMPUTING them either (previously
  // getPendingApprovalsCount fired once here and once more inside
  // assembleHomeQueue, every page load).
  const [res, feedRows, queue] = await Promise.all([
    fetchPersonalDashboardData(db, user.id, user.activeLocation?.id),
    fetchTodayFeed(db, user, user.activeLocation?.id, { skip: QUEUE_MIGRATED_IDS }),
    assembleHomeQueue(db, user),
  ])
  if (!res.success) {
    return (
      <p className="text-sm text-red-500">Failed to load dashboard: {res.error}</p>
    )
  }

  const secondaryFeedRows = feedRows.filter((row) => !QUEUE_MIGRATED_IDS.includes(row.id))
  const queueGroups = groupQueueRows(queue.rows, queue.counts)
  const queueDegraded = Boolean(queue.degraded && queue.degraded.length)
  const queueEmpty = queue.total === 0 && !queueDegraded
  // FU-COSMETICS (c) — registry-internal degradation: queue.total came
  // from getPendingApprovalsCount's own query path (a provider's
  // .countPending()), independent of the .fetchPending() path that
  // materialises queue.rows (src/lib/approvals/registry.js) — so the two
  // can disagree when only one of a provider's two query paths fails.
  // total > 0 with rows.length === 0 means the header would otherwise
  // show a confident "N+" over what renders as nothing at all (queueGroups
  // is null below 3 sources, and the flat-list branch has zero rows to
  // show) — indistinguishable from a broken page. queueCountLabel already
  // drops the "+" for this exact case; this adds the explanation.
  const queueRowsDelayed = queue.rows.length === 0 && queue.total > 0

  const {
    weekShifts, weekStartIso, weekEndIso,
    nextWeekShifts, nextWeekStartIso, nextWeekEndIso,
    shiftsThisWeek, hoursThisWeek,
    myPostedSwaps, myPendingTimeOff, unreadInbox,
    monthShifts, monthStartIso, monthEndIso,
    shiftsThisMonth, hoursThisMonth,
  } = res.data

  // Roster v2 phases 2 + 3 + 5 — manager / owner alerts.
  // Master sees these chips across all assigned locations.
  const isManager = user.role === 'master' || MANAGER_ROLES.includes(user.role)
  // Owner-only chip: pending roster approvals. Master counts as owner
  // for approval purposes; otherwise the user is "owner-somewhere"
  // if any of their per-location assignments has role='owner'.
  const ownerLocationIds = user.role === 'master'
    ? (user.locations || []).map(l => l.id)
    : Object.entries(user.rolesByLocation || {})
        .filter(([, role]) => role === 'owner')
        .map(([id]) => id)
  const isOwnerSomewhere = ownerLocationIds.length > 0

  let unstaffedCount = 0
  let incompletePay = { count: 0, sample: [] }
  let pendingApprovals = 0
  if (isManager || isOwnerSomewhere) {
    const locIds = user.role === 'master'
      ? (user.locations || []).map(l => l.id)
      : getUserLocationIds(user)
    const [unstaffedRes, payRes, approvalsRes] = await Promise.all([
      fetchUnstaffedBlocksThisWeek(db, locIds),
      fetchIncompletePayProfiles(db, locIds),
      isOwnerSomewhere ? fetchPendingRosterApprovalsCount(db, ownerLocationIds) : Promise.resolve({ success: true, data: { count: 0 } }),
    ])
    if (unstaffedRes.success) unstaffedCount = unstaffedRes.data.count
    if (payRes.success) incompletePay = payRes.data
    if (approvalsRes.success) pendingApprovals = approvalsRes.data.count
  }

  // Show the per-shift location chip only when the user is assigned
  // to 2+ locations — otherwise it's redundant clutter for staff
  // who only ever work at one gym.
  const showLocation = (user.locations || []).length > 1

  return (
    <>
      {/* HOME.3 — the needs-attention queue. First thing on the page:
          the merged, item-level list from assembleHomeQueue (approvals,
          email, unified WhatsApp/Instagram inbox), one row per
          item rather than one row per source-count — each deep-links
          straight into its own surface. Always rendered (unlike the old
          count-level feed, which hid itself entirely when empty) so an
          empty queue reads as a confirmed "all clear", not an absent
          section a viewer can't tell from a loading gap. */}
      <div className="mb-4 max-w-5xl">
        <SectionHeader title="Needs attention" count={queueCountLabel(queue.total, queue.rows.length)} />
        {queue.counts.mail === null && (
          // EMAIL-TICKET-CLEANUP.2 — a failed mailbox-visibility lookup
          // is "we don't know", never a confident zero; say so instead
          // of silently omitting the mail source.
          <p className="px-1 mb-2 text-xs text-un1t-subtle">Email unavailable right now</p>
        )}
        {queueRowsDelayed && (
          <p className="px-1 mb-2 text-xs text-un1t-subtle">Some sources may be delayed</p>
        )}
        {queueEmpty ? (
          <ListCard empty emptyText="Nothing needs your attention" />
        ) : queueGroups ? (
          // 3+ distinct sources present — subheader each with its own
          // TRUE count and a "View all" link into the full surface,
          // rather than one undifferentiated 30-row wall.
          queueGroups.map((group) => (
            <div key={group.key}>
              <SectionHeader
                title={group.label}
                count={group.count}
                action={(
                  <Link href={group.href} className="text-xs text-un1t-subtle hover:text-un1t-text">
                    View all
                  </Link>
                )}
              />
              <ListCard>
                <QueueRows rows={group.rows} />
              </ListCard>
            </div>
          ))
        ) : queue.rows.length > 0 ? (
          <ListCard>
            <QueueRows rows={queue.rows} />
          </ListCard>
        ) : null}
      </div>

      {/* TODAY-FEED.1 — the remaining today-feed rows that are NOT
          home-queue sources (anything not in QUEUE_MIGRATED_IDS): today's
          bookings, churn watch, tasks due, low-fill classes today, plus
          any future today-feed source by default. The queue-owned rows
          are filtered out here — those sources render item-level in the
          queue above instead (and fetchTodayFeed above didn't even
          compute them — see the `skip` call). Renders nothing when none
          apply, same as before. */}
      {secondaryFeedRows.length > 0 && (
        <div className="mb-4 max-w-5xl">
          <SectionHeader title="Also today" count={secondaryFeedRows.length} />
          <ListCard>
            {secondaryFeedRows.map((row, i) => (
              <PendingRow
                key={row.id}
                icon={FEED_ICONS[row.id]}
                title={row.label}
                subtitle={feedSubtitle(row)}
                time={String(row.count)}
                href={row.href}
                isLast={i === secondaryFeedRows.length - 1}
              />
            ))}
          </ListCard>
        </div>
      )}

      {/* Roster — month calendar (default) or two-week view, toggled
          by the Week | Month control inside MonthRoster. */}
      <div className="mb-4 max-w-5xl">
        <MonthRoster
          weeks={buildMonthMatrix(monthStartIso, monthEndIso, monthShifts, isoDate(new Date()))}
          monthLabel={`${new Date(monthStartIso + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })} – ${new Date(monthEndIso + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}`}
          monthSummary={`${shiftsThisMonth} shift${shiftsThisMonth === 1 ? '' : 's'} · ${hoursThisMonth}h`}
          weekPanels={[
            { title: 'This week', startIso: weekStartIso, endIso: weekEndIso, shifts: weekShifts },
            { title: 'Next week', startIso: nextWeekStartIso, endIso: nextWeekEndIso, shifts: nextWeekShifts },
          ]}
          showLocation={showLocation}
          employmentType={user.employment_type}
        />
      </div>

      <KpiRow>
        <KpiCard label="This week" value={`${hoursThisWeek}h`} sublabel={`${shiftsThisWeek} shift${shiftsThisWeek === 1 ? '' : 's'}`} href="/schedule" />
        <KpiCard
          label="Inbox"
          value={unreadInbox}
          sublabel={unreadInbox === 1 ? 'unread message' : 'unread messages'}
          accent={unreadInbox > 0 ? 'text-un1t-text' : 'text-un1t-muted'}
          href={unreadInbox > 0 ? '/communications' : undefined}
        />
      </KpiRow>

      {/* Roster v2 phase 5 — pending roster approvals for owners.
          Most operationally urgent of the three roster chips
          (it's actively blocking staff from seeing their schedule),
          so it goes first in the alert stack. */}
      {isOwnerSomewhere && pendingApprovals > 0 && (
        <Link
          href="/schedule/approvals"
          className="block mt-3 p-3 rounded-lg border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/15 transition-colors"
        >
          <div className="flex items-start gap-3">
            <ClipboardCheck size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-blue-800">
                {pendingApprovals} roster{pendingApprovals === 1 ? '' : 's'} waiting for approval
              </div>
              <div className="text-xs text-blue-700/90 mt-0.5">
                Manager-submitted draft{pendingApprovals === 1 ? '' : 's'} over budget. Staff can&apos;t see their shifts until you approve.
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* Roster v2 phase 2 — unstaffed-block alert for managers/owners.
          Empty future shift_blocks across the user's locations;
          customers will be in the studio either way, so loud surfacing
          here matches the "demand window" model. */}
      {isManager && unstaffedCount > 0 && (
        <Link
          href="/schedule"
          className="block mt-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 hover:bg-red-500/15 transition-colors"
        >
          <div className="flex items-start gap-3">
            <AlertCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-red-700">
                {unstaffedCount} unstaffed block{unstaffedCount === 1 ? '' : 's'} this week
              </div>
              <div className="text-xs text-red-700/80 mt-0.5">
                Demand windows with no coach assigned. Click to open the schedule.
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* Roster v2 phase 3 — pay-data completeness for managers.
          Phase 4's cost panel zero-costs anyone whose employment
          fields are missing, which silently understates labour
          spend. Surfacing here gives the operator a chance to fix
          before the budget panel goes live in mig 071. */}
      {isManager && incompletePay.count > 0 && (
        <Link
          href="/settings/staff"
          className="block mt-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15 transition-colors"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-800">
                {incompletePay.count} staff member{incompletePay.count === 1 ? '' : 's'} missing pay data
              </div>
              <div className="text-xs text-amber-700/90 mt-0.5">
                {incompletePay.sample.slice(0, 3).map(p => p.name).join(', ')}
                {incompletePay.count > 3 && ` and ${incompletePay.count - 3} more`}
                {' — '}
                without a rate or contracted hours, their shifts cost €0 in the budget panel.
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* CT-P3b — coach self-service swap surfaces: accept/decline swaps
          offered to you, claim open-pool swaps, and "on with you today".
          Renders nothing when all three lists are empty. */}
      <SwapActions
        locationId={user.activeLocation?.id}
        todayIso={isoDate(new Date())}
        currentProfileId={user.id}
      />

      <MyRequests
        postedSwaps={myPostedSwaps || []}
        timeOff={myPendingTimeOff}
      />
    </>
  )
}
