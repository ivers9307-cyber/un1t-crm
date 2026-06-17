// /dashboard/today — Personal dashboard. Web mirror of the mobile
// PersonalDashboard. Same data fetched from shared/dashboard-data.js.
//
// TODAY-FEED.1 made this the gym's front door: a permission-filtered
// "Needs attention" triage feed (approvals / issues / invoices /
// unread WhatsApp / today's bookings / churn risks / tasks due /
// low-fill classes) renders above the personal roster, each row
// deep-linking into its full surface. A coach with none of the queue
// permissions sees exactly what they saw before.
//
// Permission: dashboard_personal (cross-platform).

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Calendar, AlertCircle, AlertTriangle, ClipboardCheck, Inbox, MessagesSquare, Radar, CheckSquare, Flag } from 'lucide-react'
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
import {
  KpiCard, KpiRow, SectionHeader, ListCard, PendingRow,
} from '@/components/dashboard/Cards'
import MonthRoster from '@/components/dashboard/MonthRoster'
import MyRequests from '@/components/dashboard/MyRequests'
import SwapActions from '@/components/dashboard/SwapActions'

// Icon per triage row id (assembleTodayFeed in shared/today-feed.js
// owns the ids). Kept here — icons are a web rendering concern.
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

// One line of context under a feed row: the detail string (e.g. the
// churn delta) followed by up to three item labels.
function feedSubtitle(row) {
  const items = (row.items || []).map((it) =>
    it.sublabel ? `${it.label} (${it.sublabel})` : it.label)
  return [row.detail, ...items].filter(Boolean).join(' · ') || undefined
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
  // TODAY-FEED.1 — the triage feed fetches in parallel with the
  // personal data; it gates per-source internally and never throws.
  const [res, feedRows] = await Promise.all([
    fetchPersonalDashboardData(db, user.id, user.activeLocation?.id),
    fetchTodayFeed(db, user, user.activeLocation?.id),
  ])
  if (!res.success) {
    return (
      <p className="text-sm text-red-500">Failed to load dashboard: {res.error}</p>
    )
  }

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
      {/* TODAY-FEED.1 — the triage feed. First thing on the page:
          everything across the gym that needs the viewer, one row per
          queue, deep-linking into the full surface. Renders nothing
          when the viewer has no queue permissions or nothing is
          pending — staff see their roster exactly as before. */}
      {feedRows.length > 0 && (
        <div className="mb-4 max-w-5xl">
          <SectionHeader title="Needs attention" count={feedRows.length} />
          <ListCard>
            {feedRows.map((row, i) => (
              <PendingRow
                key={row.id}
                icon={FEED_ICONS[row.id]}
                title={row.label}
                subtitle={feedSubtitle(row)}
                time={String(row.count)}
                href={row.href}
                isLast={i === feedRows.length - 1}
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
          monthLabel={new Date(monthStartIso + 'T00:00:00').toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })}
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
          href={unreadInbox > 0 ? '/whatsapp' : undefined}
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
