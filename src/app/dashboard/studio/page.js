// /dashboard/studio — STUDIO-KPI.1: the revenue KPI scorecard, split by
// location. Home of the management operating rhythm (Richard 2026-08-04):
// GM owns the money + funnel, Director of Coaching owns retention, Head
// Coaches own the floor. One streamed column per accessible studio —
// side-by-side across locations, which the (single-location) Business
// tab deliberately doesn't do.
//
// Degradation follows the Business-page rule: a failing data source
// blanks its own cells ('unavailable'), never the column — only a
// wholesale failure shows BlockError. The pre-KPI operational Studio
// view (pending time-off / swaps / unread) lives on in the Business
// "needs you" rail, /schedule and the mobile Studio tab
// (fetchStudioDashboardData is untouched — mobile still consumes it).

import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { loadRadar } from '@/lib/churn-radar-data'
import { fetchFunnelCounts } from '@shared/dashboard-data'
import {
  fetchMrr, fetchGrowth, fetchRevenueChurn, fetchEngagement,
  fetchFloor, fetchAdSpendMTD,
} from '@shared/studio-kpis'
import { BlockSkeleton, BlockError } from '@/components/dashboard/BusinessBlocks'
import {
  ScoreCell, ScoreGrid, RoleSection, FloorTable, LocationEmptyState,
  NotTrackedYet, euros,
} from '@/components/dashboard/StudioScorecard'

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

async function loadLocationScorecard(locationId) {
  const db = createServerClient()
  // MRR first — its average yield prices unstamped (pre-mig-480)
  // cancels in the revenue-churn figure. Everything else is parallel.
  const mrr = await soft(fetchMrr(db, locationId))
  const estYield = mrr?.yieldCents || 0

  const [growth, churn, funnel, engagement, floor, spend, radar] =
    await Promise.all([
      soft(fetchGrowth(db, locationId)),
      soft(fetchRevenueChurn(db, locationId, estYield)),
      soft(fetchFunnelCounts(db, locationId)),
      soft(fetchEngagement(db, locationId)),
      soft(fetchFloor(db, locationId)),
      soft(fetchAdSpendMTD(db, locationId)),
      loadRadar(db, locationId).catch(() => null),
    ])
  // Wholesale failure (e.g. DB unreachable) → column-level error.
  if (!mrr && !growth && !funnel && !engagement && !floor) return null
  return {
    mrr, growth, churn, funnel, engagement, floor, spend,
    radarSummary: radar?.summary || null,
  }
}

async function LocationColumn({ location }) {
  let vm = null
  try {
    vm = await loadLocationScorecard(location.id)
  } catch {
    vm = null
  }
  if (!vm) return <BlockError label={`${location.name} scorecard`} />

  const { mrr, growth, churn, funnel, engagement, floor, spend, radarSummary } = vm

  // A location with no recurring base AND no class sync has no Glofox
  // connection yet (Hatch until onboarded) — say so instead of zeros.
  if (mrr && floor && mrr.recurringMembers === 0 && floor.noData) {
    return <LocationEmptyState name={location.name} />
  }

  // CAC divides by NEW MEMBERS (converted_at), not new contacts —
  // joined_at is stamped for every Glofox lead, and spend ÷ leads
  // masquerading as cost-per-member would flatter the number badly.
  const cac = spend && funnel && spend.spendMTD > 0 && funnel.converted > 0
    ? Math.round(spend.spendMTD / funnel.converted)
    : null
  const saveRate = radarSummary?.recovery?.contacted > 0
    ? Math.round(radarSummary.recovery.recoveryRate * 100)
    : null
  const trialDone = funnel?.stages.find(s => s.slug === 'trial_done')?.count ?? null

  return (
    <div>
      <ScoreGrid>
        <ScoreCell
          label="MRR"
          value={mrr ? euros(mrr.mrrCents) : null}
          sublabel={mrr
            ? `${mrr.recurringMembers} active recurring · ${euros(mrr.yieldCents) ?? '—'}/member yield`
            : UNAVAILABLE}
        />
        <ScoreCell
          label="Net growth MTD"
          value={growth
            ? (growth.netRecurringMTD > 0 ? `+${growth.netRecurringMTD}` : growth.netRecurringMTD)
            : null}
          sublabel={growth
            ? `${growth.recurringStartsMTD} started · ${growth.recurringCancelsMTD} cancelled`
            : UNAVAILABLE}
          accent={growth && growth.netRecurringMTD !== 0
            ? (growth.netRecurringMTD > 0 ? 'text-green-700' : 'text-red-700')
            : undefined}
        />
        <ScoreCell
          label="New members MTD"
          value={funnel ? funnel.converted : null}
          sublabel={funnel ? 'became members this month' : UNAVAILABLE}
          href="/contacts"
        />
        <ScoreCell
          label="Trial conversion"
          value={funnel?.conversionPct != null ? `${funnel.conversionPct}%` : null}
          sublabel={funnel
            ? `${funnel.converted} converted · ${funnel.entered} entered this month · target ${TARGETS.trialConversionPct}%`
            : UNAVAILABLE}
          accent={toneAbove(funnel?.conversionPct, TARGETS.trialConversionPct)}
        />
        <ScoreCell
          label="Revenue churn MTD"
          value={churn ? euros(churn.churnCents) : null}
          estimated={churn?.estimatedCount > 0}
          sublabel={churn
            ? `${churn.total} cancels · ${churn.early} early / ${churn.tenured} tenured`
            : UNAVAILABLE}
          accent={churn?.total > 0 ? 'text-red-700' : undefined}
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
            label="New leads MTD"
            value={funnel ? funnel.entered : null}
            sublabel={funnel ? 'entered the funnel' : UNAVAILABLE}
            href="/dashboard/lead-radar"
          />
          <ScoreCell
            label="Trials done"
            value={trialDone}
            sublabel={funnel ? 'at the decision point now' : UNAVAILABLE}
            href="/contacts?status=trial_done"
          />
          <ScoreCell
            label="Ad spend MTD"
            value={spend && spend.spendMTD > 0 ? euros(Math.round(spend.spendMTD * 100)) : null}
            sublabel={spend ? 'Meta, campaign level' : UNAVAILABLE}
            href="/dashboard/ads"
          />
          <ScoreCell
            label="CAC"
            value={cac != null ? `€${cac}` : null}
            sublabel={spend ? 'Meta spend ÷ new members' : UNAVAILABLE}
          />
        </ScoreGrid>
      </RoleSection>

      <RoleSection title="Keep the base" hint="Director of Coaching">
        <ScoreGrid>
          <ScoreCell
            label="Active member rate"
            value={engagement?.activeRatePct != null ? `${engagement.activeRatePct}%` : null}
            sublabel={engagement
              ? `≥1 class in 30d · target ${TARGETS.activeRatePct}%`
              : UNAVAILABLE}
            accent={toneAbove(engagement?.activeRatePct, TARGETS.activeRatePct)}
          />
          <ScoreCell
            label="Visits / member / wk"
            value={engagement ? engagement.visitsPerMemberWeek : null}
            sublabel={engagement
              ? `across ${engagement.members} members · target ${TARGETS.visitsPerMemberWeek}`
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
            sublabel={floor ? `target under ${TARGETS.noShowPct}%` : UNAVAILABLE}
            accent={toneBelow(floor?.noShowPct, TARGETS.noShowPct)}
          />
          <ScoreCell
            label="New-joiner activation"
            value={floor?.activation.activatedPct != null ? `${floor.activation.activatedPct}%` : null}
            sublabel={floor
              ? (floor.activation.cohort > 0
                ? `≥3 visits in first 14d · ${floor.activation.cohort} joiner${floor.activation.cohort === 1 ? '' : 's'}`
                : 'no complete cohort yet')
              : UNAVAILABLE}
          />
          <ScoreCell
            label="Attended visits 28d"
            value={floor ? floor.attendedVisits : null}
            sublabel={floor ? `across ${floor.classes} classes` : UNAVAILABLE}
          />
        </ScoreGrid>
        <div className="mt-2">
          <FloorTable rows={floor?.groupTable || []} groupedBy={floor?.groupedBy} />
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
              <LocationColumn location={loc} />
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
