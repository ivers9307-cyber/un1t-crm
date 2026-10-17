// /dashboard/studio — STUDIO-KPI.1: the revenue KPI scorecard, split by
// location. Home of the management operating rhythm (Richard 2026-08-04):
// GM owns the money + funnel, Director of Coaching owns retention, Head
// Coaches own the floor. One streamed column per accessible studio —
// side-by-side across locations, which the (single-location) Business
// tab deliberately doesn't do.
//
// STUDIO-KPI.3 — every flow metric is a ROLLING 28-day window with the
// preceding 28 days as its comparator, not month-to-date. The board is
// read at a weekly management meeting, and an MTD figure means one
// thing on week 1 and another on week 4, so week-over-week movement was
// mostly the calendar refilling. Stocks (MRR, arrears, at-risk, trials
// done) stay point-in-time — a rolling window is meaningless for them.
//
// Degradation follows the Business-page rule: a failing data source
// blanks its own cells ('unavailable'), never the column — only a
// wholesale failure shows BlockError. The pre-KPI operational Studio
// view (pending time-off / swaps / unread) lives on in the Business
// "needs you" rail, /schedule and the mobile Studio tab (its WhatsApp
// unread total through shared fetchStudioDashboardData; its pending lists
// through /api/schedule/time-off and /api/schedule/swaps; its contact
// numbers through /api/dashboard/studio-contacts).

import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadRadar } from '@/lib/churn-radar-data'
import {
  fetchRevenueChurn,
  fetchFloor, fetchAdSpend, fetchAcquisition,
} from '@shared/studio-kpis'
import { BlockSkeleton, BlockError } from '@/components/dashboard/BusinessBlocks'
import { WINDOW_DAYS } from '@shared/studio-kpi-math'
import {
  ScoreCell, ScoreGrid, RoleSection, FloorTable, LocationEmptyState,
  NotTrackedYet, euros,
} from '@/components/dashboard/StudioScorecard'
import { membershipSettingsHref, canManageMembershipSource, providesCapability } from '@/lib/membership/state-for-page'
import { membershipReadsFor, supportsRead } from '@/lib/membership/reads'
import MembershipSourceGate from '@/components/MembershipSourceGate'

export const dynamic = 'force-dynamic'

// Framework targets — staff-facing hints (the operator-editable-copy
// rule binds customer surfaces, not this internal scorecard).
const TARGETS = {
  fillPct: 70, noShowPct: 10, activeRatePct: 65, visitsPerMemberWeek: 2,
  trialConversionPct: 40,
}

const UNAVAILABLE = 'unavailable'

function toneAbove(value, target) {
  if (value == null) return undefined
  return value >= target ? 'text-green-700' : 'text-amber-700'
}

function toneBelow(value, target) {
  if (value == null) return undefined
  return value <= target ? 'text-green-700' : 'text-amber-700'
}

// {success,data} → data | null; a rejected promise is also null. Each
// data source degrades its own cells, matching the Business page's
// per-block error posture.
function soft(promise) {
  return promise.then(r => (r?.success ? r.data : null)).catch(() => null)
}

// UN1TREAD.4 — MRR, net growth and the active-member rate come through the
// membership read seam (`r` is membershipReadsFor()'s answer, resolved ONCE by
// the column). A Glofox adapter forwards the same arguments to the same
// fetchers, so a Glofox column is unchanged. un1t.online supplies those three;
// revenue churn needs membership_transitions.price_cents (Glofox only) and the
// radar cells read Glofox tables (behind the memberships capability), so both
// are null there and draw '— unavailable'. So does acquisition (UN1TREAD.7):
// fetchAcquisition counts contacts.converted_at / joined_at / pipeline_stage_slug,
// which only the Glofox sync and classifier set, so New members, Trial
// conversion, New leads, Trials done and CAC are Glofox-fed too. The floor
// reads class tables and stays source-agnostic, EXCEPT that its booking-derived
// figures only exist for Glofox (UN1TCLASS.3): see withoutBookingKpis().

// UN1TCLASS.3 / UN1TBOOK.4 — Hatch Street's class_occurrences are projected from
// its un1t.online timetable (raw.booked = bookings_count), so Classes and Fill
// compute honestly. Since UN1TBOOK.3 its bookings are projected into
// class_bookings too (source_platform 'un1t_online', status BOOKED with the
// `attended` boolean, CANCELLED for cancelled: the Glofox shape, so computeFloor
// counts them), and the no-show rate and attended visits (and the per-group
// no-show) are real there: keepAttendance. Review Focus 5: a past un1t class
// nobody marked stays booked, so it projects BOOKED / attended=false and counts
// as a no-show, exactly like an unmarked Glofox booking.
//
// New-joiner activation stays unavailable for un1t_online: its cohort is
// contacts.converted_at at the location, which the un1t sync never writes (and
// which would miss the dual-studio members). A source with no projection at all
// keeps all three booking cells "no data", not 0: an empty class_bookings table
// would compute 0% / 0, a plausible-looking wrong number. Null them so the cells
// draw '— unavailable'. Per-group fill is kept; the per-group no-show follows
// the no-show rate (FloorTable draws '—'). Everything else (classes, fill,
// 7-day fill, noData, groupedBy) passes through as fetchFloor computed it.
function withoutBookingKpis(floor, { keepAttendance = false } = {}) {
  if (!floor) return floor
  return {
    ...floor,
    activation: null,
    ...(keepAttendance
      ? {}
      : {
        noShowPct: null,
        attendedVisits: null,
        groupTable: (floor.groupTable || []).map((g) => ({ ...g, noShowPct: null })),
      }),
  }
}

async function loadLocationScorecard(locationId, r) {
  const db = createServerClient()
  const glofox = r.source === 'glofox'
  // Booking-derived no-show and attended visits exist where class_bookings is
  // written: Glofox's sync and the un1t.online projection (UN1TBOOK.3).
  const attendanceKpis = glofox || r.source === 'un1t_online'
  const radarOk = providesCapability(r, 'memberships')
  // MRR first — its average yield prices unstamped (pre-mig-480)
  // cancels in the revenue-churn figure. Everything else is parallel.
  const mrr = await soft(r.reads.mrr(db, locationId))
  const estYield = mrr?.yieldCents || 0

  const [growth, churn, acq, engagement, floor, spend, radar] =
    await Promise.all([
      supportsRead(r, 'growth') ? soft(r.reads.growth(db, locationId)) : null,
      glofox ? soft(fetchRevenueChurn(db, locationId, estYield)) : null,
      glofox ? soft(fetchAcquisition(db, locationId)) : null,
      supportsRead(r, 'engagement') ? soft(r.reads.engagement(db, locationId)) : null,
      soft(fetchFloor(db, locationId)).then((f) => (glofox ? f : withoutBookingKpis(f, { keepAttendance: attendanceKpis }))),
      soft(fetchAdSpend(db, locationId)),
      radarOk ? loadRadar(db, locationId).catch(() => null) : null,
    ])
  // Wholesale failure (e.g. DB unreachable) → column-level error.
  if (!mrr && !growth && !acq && !engagement && !floor) return null
  return {
    mrr, growth, churn, acq, engagement, floor, spend,
    // Activation and the Glofox trainer footer exist only for Glofox; the
    // no-show and attended-visits cells follow attendanceKpis.
    bookingKpis: glofox,
    attendanceKpis,
    radarSummary: radar?.summary || null,
  }
}

async function LocationColumn({ user, location }) {
  // W1.M3a — every KPI here is a membership or class-sync figure, so the
  // column gates on THIS studio's membership source before any query
  // runs (the board is per-studio: Stillorgan's column is unchanged while
  // Hatch Street's says why it is empty). The state read is cached 60 s.
  // UN1TREAD.4 — asked ONCE through the read seam: the gate copy and the
  // numbers are drawn from the same answer, so they cannot disagree. The
  // column renders when the adapter reads MRR (Glofox and un1t.online);
  // otherwise the gate, with capability forced off so a CONFIGURED source
  // that cannot read MRR says "does not provide" rather than rendering nothing.
  const r = await membershipReadsFor(createServerClient(), location.id)
  if (!supportsRead(r, 'mrr')) {
    const gateState = {
      source: r.source, state: r.state, label: r.label, readError: r.error,
      missing: r.missing, capabilities: { ...(r.capabilities || {}), memberships: false },
    }
    return (
      <MembershipSourceGate
        state={gateState}
        capability="memberships"
        settingsHref={membershipSettingsHref(location.id)}
        canManage={canManageMembershipSource(user, location.id)}
        padding="md"
        className="bg-un1t-surface border border-un1t-border rounded-2xl"
      />
    )
  }

  let vm = null
  try {
    vm = await loadLocationScorecard(location.id, r)
  } catch {
    vm = null
  }
  if (!vm) return <BlockError label={`${location.name} scorecard`} />

  const { mrr, growth, churn, acq, engagement, floor, spend, radarSummary, bookingKpis, attendanceKpis } = vm
  const W = WINDOW_DAYS

  // A CONFIGURED source with no recurring base AND no class sync has not
  // synced anything yet (a studio in its first hours) — say so instead
  // of zeros. "Not connected" is the gate's job above, not this inference's.
  if (mrr && floor && mrr.recurringMembers === 0 && floor.noData) {
    return <LocationEmptyState name={location.name} />
  }

  // CAC divides by NEW MEMBERS (converted_at), not new contacts —
  // joined_at is stamped for every Glofox lead, and spend ÷ leads
  // masquerading as cost-per-member would flatter the number badly.
  // Both sides share the window, and so does the comparator.
  const cacFor = (spendAmount, members) => (spendAmount > 0 && members > 0
    ? Math.round(spendAmount / members)
    : null)
  const cac = spend && acq ? cacFor(spend.spend, acq.newMembers) : null
  const prevCac = spend && acq ? cacFor(spend.prevSpend, acq.prevNewMembers) : null
  // Lower CAC is better, so the delta's "good" direction is inverted.
  const cacDelta = cac != null && prevCac != null ? cac - prevCac : null
  const saveRate = radarSummary?.recovery?.contacted > 0
    ? Math.round(radarSummary.recovery.recoveryRate * 100)
    : null

  return (
    <div>
      <ScoreGrid>
        <ScoreCell
          label="MRR"
          value={mrr ? euros(mrr.mrrCents) : null}
          sublabel={mrr
            ? `${mrr.recurringMembers} billing now · ${euros(mrr.yieldCents) ?? '—'}/member yield`
            : UNAVAILABLE}
        />
        <ScoreCell
          label={`Net growth ${W}d`}
          value={growth
            ? (growth.netRecurring > 0 ? `+${growth.netRecurring}` : growth.netRecurring)
            : null}
          sublabel={growth
            ? `${growth.recurringStarts} started · ${growth.recurringCancels} cancelled`
            : UNAVAILABLE}
          accent={growth && growth.netRecurring !== 0
            ? (growth.netRecurring > 0 ? 'text-green-700' : 'text-red-700')
            : undefined}
          delta={growth?.netRecurringDelta}
          windowDays={W}
        />
        <ScoreCell
          label={`New members ${W}d`}
          value={acq ? acq.newMembers : null}
          sublabel={acq ? 'became members' : UNAVAILABLE}
          delta={acq?.newMembersDelta}
          windowDays={W}
          href="/contacts"
        />
        <ScoreCell
          label="Trial conversion"
          value={acq?.conversionPct != null ? `${acq.conversionPct}%` : null}
          sublabel={acq
            ? `${acq.newMembers} of ${acq.leads} leads · target ${TARGETS.trialConversionPct}%`
            : UNAVAILABLE}
          accent={toneAbove(acq?.conversionPct, TARGETS.trialConversionPct)}
          delta={acq?.conversionDelta}
          deltaFormat={n => `${n}pp`}
          windowDays={W}
        />
        <ScoreCell
          label={`Revenue churn ${W}d`}
          value={churn ? euros(churn.churnCents) : null}
          estimated={churn?.estimatedCount > 0}
          sublabel={churn
            ? `${churn.total} cancels · ${churn.early} early / ${churn.tenured} tenured`
            : UNAVAILABLE}
          accent={churn?.total > 0 ? 'text-red-700' : undefined}
          delta={churn?.churnCentsDelta}
          deltaHigherIsBetter={false}
          deltaFormat={n => euros(n)}
          windowDays={W}
        />
        <ScoreCell
          label="Arrears"
          value={radarSummary ? euros(radarSummary.overdueValueCents) : null}
          sublabel={radarSummary
            ? `${radarSummary.overdue} member${radarSummary.overdue === 1 ? '' : 's'} overdue`
            : UNAVAILABLE}
          accent={radarSummary?.overdue > 0 ? 'text-red-700' : undefined}
          href="/dashboard/churn-radar"
        />
      </ScoreGrid>

      <RoleSection title="Grow the base" hint="GM">
        <ScoreGrid>
          <ScoreCell
            label={`New leads ${W}d`}
            value={acq ? acq.leads : null}
            sublabel={acq ? 'entered the funnel' : UNAVAILABLE}
            delta={acq?.leadsDelta}
            windowDays={W}
            href="/dashboard/lead-radar"
          />
          <ScoreCell
            label="Trials done"
            value={acq ? acq.trialsDone : null}
            sublabel={acq ? 'at the decision point now' : UNAVAILABLE}
            href="/contacts?status=trial_done"
          />
          <ScoreCell
            label={`Ad spend ${W}d`}
            value={spend && spend.spend > 0 ? euros(Math.round(spend.spend * 100)) : null}
            sublabel={spend ? 'Meta, campaign level' : UNAVAILABLE}
            href="/dashboard/ads"
          />
          <ScoreCell
            label="CAC"
            value={cac != null ? `€${cac}` : null}
            sublabel={spend && acq ? `Meta spend ÷ new members, ${W}d` : UNAVAILABLE}
            delta={cacDelta}
            deltaHigherIsBetter={false}
            deltaFormat={n => `€${n}`}
            windowDays={W}
          />
        </ScoreGrid>
      </RoleSection>

      <RoleSection title="Keep the base" hint="Director of Coaching">
        <ScoreGrid>
          <ScoreCell
            label="Active member rate"
            value={engagement?.activeRatePct != null ? `${engagement.activeRatePct}%` : null}
            sublabel={engagement
              ? `${engagement.activeMembers} of ${engagement.members} monthly recurring · target ${TARGETS.activeRatePct}%`
              : UNAVAILABLE}
            accent={toneAbove(engagement?.activeRatePct, TARGETS.activeRatePct)}
          />
          <ScoreCell
            label="Visits / member / wk"
            value={engagement ? engagement.visitsPerMemberWeek : null}
            sublabel={engagement
              ? `across ${engagement.members} monthly recurring · target ${TARGETS.visitsPerMemberWeek}`
              : UNAVAILABLE}
            accent={toneAbove(engagement?.visitsPerMemberWeek, TARGETS.visitsPerMemberWeek)}
          />
          <ScoreCell
            label="At risk"
            value={radarSummary?.atRisk ?? null}
            sublabel={radarSummary
              ? `${radarSummary.highRisk} high risk · ${euros(radarSummary.revenueAtRiskCents)} at stake`
              : UNAVAILABLE}
            accent={radarSummary?.highRisk > 0 ? 'text-amber-700' : undefined}
            href="/dashboard/churn-radar"
          />
          <ScoreCell
            label="At-risk saves"
            value={saveRate != null ? `${saveRate}%` : null}
            sublabel={radarSummary
              ? (radarSummary.recovery?.contacted
                ? `${radarSummary.recovery.recovered} of ${radarSummary.recovery.contacted} contacted came back`
                : 'no interventions measured yet')
              : UNAVAILABLE}
          />
        </ScoreGrid>
      </RoleSection>

      <RoleSection title="The floor" hint="Head Coach">
        <ScoreGrid>
          <ScoreCell
            label="Fill rate 28d"
            value={floor?.fillPct != null ? `${floor.fillPct}%` : null}
            sublabel={floor
              ? `${floor.fillPct7d != null ? `${floor.fillPct7d}% last 7d · ` : ''}target ${TARGETS.fillPct}%`
              : UNAVAILABLE}
            accent={toneAbove(floor?.fillPct, TARGETS.fillPct)}
          />
          <ScoreCell
            label="No-show rate 28d"
            value={floor?.noShowPct != null ? `${floor.noShowPct}%` : null}
            sublabel={floor && attendanceKpis ? `target under ${TARGETS.noShowPct}%` : UNAVAILABLE}
            accent={toneBelow(floor?.noShowPct, TARGETS.noShowPct)}
          />
          <ScoreCell
            label="New-joiner activation"
            value={floor?.activation?.activatedPct != null ? `${floor.activation.activatedPct}%` : null}
            sublabel={floor && bookingKpis
              ? (floor.activation.cohort > 0
                ? `≥3 visits in first 14d · ${floor.activation.cohort} joiner${floor.activation.cohort === 1 ? '' : 's'}`
                : 'no complete cohort yet')
              : UNAVAILABLE}
          />
          <ScoreCell
            label="Attended visits 28d"
            value={floor ? floor.attendedVisits : null}
            sublabel={floor && attendanceKpis ? `across ${floor.classes} classes` : UNAVAILABLE}
          />
        </ScoreGrid>
        <div className="mt-2">
          <FloorTable rows={floor?.groupTable || []} groupedBy={floor?.groupedBy} bookingKpis={bookingKpis} />
        </div>
      </RoleSection>
    </div>
  )
}

export default async function StudioDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'dashboard_studio')) redirect('/dashboard')

  // Every studio the viewer can see in the active organization — the
  // GM / Director of Coaching get both studios side by side; a head
  // coach gets their own. Active location leads.
  const orgId = user.activeOrganization?.id
  const activeId = user.activeLocation?.id
  const visible = (user.locations || [])
    .filter(l => l && l.active !== false)
    .filter(l => !orgId || l.organization_id === orgId)
    .filter(l => hasPermissionForLocation(user, l.id, 'dashboard_studio'))
    .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : (a.name || '').localeCompare(b.name || '')))
  const locations = visible.slice(0, 4)
  const hidden = visible.length - locations.length

  if (locations.length === 0) {
    return <p className="text-sm text-un1t-subtle">No studios visible for this account.</p>
  }

  return (
    <>
      <div className={`grid gap-6 ${locations.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {locations.map(loc => (
          <div key={loc.id}>
            <h2 className="text-sm font-semibold text-un1t-text mb-2 px-1">{loc.name}</h2>
            <Suspense fallback={<BlockSkeleton lines={8} />}>
              <LocationColumn user={user} location={loc} />
            </Suspense>
          </div>
        ))}
      </div>
      {hidden > 0 ? (
        <p className="text-xs text-un1t-subtle mt-3 px-1">
          {hidden} more studio{hidden === 1 ? '' : 's'} not shown — switch location to view.
        </p>
      ) : null}
      <NotTrackedYet />
    </>
  )
}
