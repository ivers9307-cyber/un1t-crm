// Roster v2 phase 4 — week + month summary panel rendered below
// the schedule calendar. Read-only / advisory: no enforcement,
// just shows the operator what they're staffing toward. Phase 5
// will wire the publish gate that actually stops over-budget
// rosters from going live.
//
// Visible to managers + master only (caller controls render).
// Two halves:
//   - Per-coach FTE utilisation bars (allocated / contracted)
//   - Contractor euro spend for the focused month vs the
//     location's monthly_contractor_budget_eur
//
// RSC-AUDIT.2: no own state / events / refs / browser APIs —
// pure data transformation via summarizeWeek / summarizeMonth +
// JSX render. Intl.NumberFormat + new Date(y, m, 1) are universal
// (not browser-only). Parent ScheduleCalendar is a Client
// Component, so this gets implicit-client-bundled with the same
// end result. Drops one explicit boundary directive.

import { TrendingUp, TrendingDown, AlertTriangle, Wallet } from 'lucide-react'
import { summarizeWeek } from '@/lib/roster-summary'

// Text colours use the -700 ramp so they read clearly against
// the light card background (un1t-surface = #F7F8FA). The -300
// variants we'd use on a dark theme look washed-out here. Same
// retune we did for shared/location-colors.js after the light-
// theme migration.
const STATUS_STYLES = {
  // Rostered during fully-approved leave — the loudest red, this
  // is a roster bug, not a workload signal.
  on_leave:    { bar: 'bg-red-600',     label: 'Rostered on leave', text: 'text-red-700' },
  overtime:    { bar: 'bg-red-500',     label: 'Over hours',        text: 'text-red-700' },
  on_target:   { bar: 'bg-emerald-500', label: 'On target',         text: 'text-emerald-700' },
  underused:   { bar: 'bg-amber-500',   label: 'Underused',         text: 'text-amber-700' },
  no_contract: { bar: 'bg-un1t-muted',    label: 'No contract',       text: 'text-un1t-subtle' },
}

function formatEur(amount) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(amount || 0)
}

function monthLabel(iso) {
  const [y, m] = iso.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
}

export default function RosterSummaryPanel({
  blocks, staff, weekStart, timeOff,
  // SCHEDULE-SPEND-AGG.1 — the month half (contractor spend vs
  // budget) is now sourced from a server-computed aggregate via the
  // `contractorSpend` prop. It's null while the parent is fetching.
  // monthStart + location were the inputs the old client-side
  // summarizeMonth needed; the parent still passes them but we don't
  // read them here.
  // eslint-disable-next-line no-unused-vars
  monthStart, location,
  contractorSpend,
  // Head_coach + manager-but-not-admin can't see hourly_rate
  // client-side, so the per-coach "pay data missing" warning would
  // fire on every coach uselessly. Caller passes `canSeePay=false`
  // to suppress it for those roles. Defaults true for backwards
  // compat.
  canSeePay = true,
}) {
  const week = summarizeWeek({
    blocks,
    staff,
    weekStart,
    timeOff,
  })
  const month = contractorSpend

  return (
    <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* FTE utilisation */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp size={14} className="text-blue-400" />
            FTE utilisation — this week
          </h3>
          <span className="text-[11px] text-un1t-subtle">
            {week.fte.length} {week.fte.length === 1 ? 'coach' : 'coaches'} rostered
          </span>
        </div>

        {week.fte.length === 0 ? (
          <p className="text-xs text-un1t-subtle py-2">
            No FTE coaches assigned to this week yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {week.fte.map(row => {
              const style = STATUS_STYLES[row.status] || STATUS_STYLES.underused
              const pct = row.utilisation_pct
              const onLeave = row.leave_hours > 0
              // Cap the visual bar at 100% so an over-hours coach
              // doesn't break the layout, but show the real number.
              // Phase 6: when leave reduces effective contract,
              // the bar's denominator is the EFFECTIVE figure
              // (so 21h on a 30h contract w/ 9h leave reads as
              // 100% — the coach is fully utilised against their
              // available hours).
              const barWidthPct = (() => {
                if (pct == null) return 0
                if (pct >= 999) return 100   // sentinel — rostered while on full leave
                return Math.min(pct, 100)
              })()
              const denomLabel = row.contracted_hours > 0 && row.effective_contracted_hours !== row.contracted_hours
                ? `${row.effective_contracted_hours}h (of ${row.contracted_hours}h)`
                : row.contracted_hours > 0
                  ? `${row.contracted_hours}h`
                  : null
              return (
                <div key={row.profile_id}>
                  <div className="flex items-center justify-between text-xs mb-1 gap-2">
                    <span className="font-medium text-un1t-text truncate">{row.full_name}</span>
                    <span className={`flex-shrink-0 text-right ${style.text}`}>
                      {row.allocated_hours}h
                      {denomLabel && ` / ${denomLabel}`}
                      {pct != null && pct < 999 && ` · ${pct}%`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-un1t-border/40 rounded overflow-hidden">
                    <div className={`h-full ${style.bar}`} style={{ width: `${barWidthPct}%` }} />
                  </div>
                  <div className={`text-[10px] mt-0.5 flex items-center justify-between gap-2 ${style.text}`}>
                    <span>{style.label}</span>
                    {onLeave && (
                      <span className="text-un1t-subtle">
                        {row.leave_hours}h on leave this week
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {canSeePay && week.incompleteProfileNames.length > 0 && (
          <div className="mt-3 pt-3 border-t border-un1t-border flex items-start gap-2 text-[11px] text-amber-700">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-amber-600" />
            <span>
              Pay data missing for {week.incompleteProfileNames.slice(0, 3).join(', ')}
              {week.incompleteProfileNames.length > 3 && ` and ${week.incompleteProfileNames.length - 3} more`}
              {' — those shifts cost €0 in the budget calc.'}
            </span>
          </div>
        )}
      </div>

      {/* Contractor budget — server-computed via SCHEDULE-SPEND-AGG.1
          so head_coach sees the totals without being granted
          hourly_rate visibility. While the parent is fetching the
          aggregate, month is null and we show a calculating state. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
        {month == null ? (
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Wallet size={14} className="text-emerald-400" /> Contractor spend
            </h3>
            <span className="text-[11px] text-un1t-subtle">Calculating…</span>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Wallet size={14} className="text-emerald-400" />
                Contractor spend — {monthLabel(month.monthStartIso)}
              </h3>
              {month.utilisationPct != null && (
                <span className={`text-[11px] font-medium ${month.overBudget ? 'text-red-700' : 'text-un1t-subtle'}`}>
                  {month.utilisationPct}% of budget
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Spent</div>
                <div className={`text-xl font-semibold ${month.overBudget ? 'text-red-700' : 'text-un1t-text'}`}>
                  {formatEur(month.contractorCostEur)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Budget</div>
                <div className="text-xl font-semibold text-un1t-text">
                  {month.monthlyBudgetEur != null ? formatEur(month.monthlyBudgetEur) : <span className="text-un1t-subtle">Not set</span>}
                </div>
              </div>
            </div>

            {month.monthlyBudgetEur != null && (
              <>
                <div className="h-1.5 bg-un1t-border/40 rounded overflow-hidden">
                  <div
                    className={`h-full ${month.overBudget ? 'bg-red-500' : month.utilisationPct >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(month.utilisationPct ?? 0, 100)}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px]">
                  <span className={month.overBudget ? 'text-red-700 font-medium' : 'text-un1t-subtle'}>
                    {month.overBudget
                      ? <><TrendingDown size={11} className="inline mr-1" /> {formatEur(Math.abs(month.remainingEur))} over</>
                      : `${formatEur(month.remainingEur)} remaining`}
                  </span>
                  <span className="text-un1t-muted">FTE labour (sunk cost): {formatEur(month.fteImplicitCostEur)}</span>
                </div>
              </>
            )}

            {month.monthlyBudgetEur == null && (
              <p className="text-[11px] text-un1t-subtle mt-1">
                Set a monthly contractor budget in <span className="font-medium">Settings → Locations</span> to track spend against a ceiling.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
