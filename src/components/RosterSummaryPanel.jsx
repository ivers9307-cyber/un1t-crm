'use client'

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

import { TrendingUp, TrendingDown, AlertTriangle, Wallet } from 'lucide-react'
import { summarizeWeek, summarizeMonth } from '@/lib/roster-summary'

const STATUS_STYLES = {
  overtime:    { bar: 'bg-red-500',    label: 'Over hours',     text: 'text-red-300' },
  on_target:   { bar: 'bg-emerald-500', label: 'On target',      text: 'text-emerald-300' },
  underused:   { bar: 'bg-amber-500',   label: 'Underused',      text: 'text-amber-300' },
  no_contract: { bar: 'bg-un1t-mid',    label: 'No contract',    text: 'text-un1t-light' },
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

export default function RosterSummaryPanel({ blocks, staff, weekStart, monthStart, location }) {
  const week = summarizeWeek({
    blocks,
    staff,
    weekStart,
  })
  const month = summarizeMonth({
    blocks,
    staff,
    referenceDate: monthStart || weekStart,
    monthlyBudgetEur: location?.monthly_contractor_budget_eur ?? null,
  })

  return (
    <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* FTE utilisation */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp size={14} className="text-blue-400" />
            FTE utilisation — this week
          </h3>
          <span className="text-[11px] text-un1t-light">
            {week.fte.length} {week.fte.length === 1 ? 'coach' : 'coaches'} rostered
          </span>
        </div>

        {week.fte.length === 0 ? (
          <p className="text-xs text-un1t-light py-2">
            No FTE coaches assigned to this week yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {week.fte.map(row => {
              const style = STATUS_STYLES[row.status] || STATUS_STYLES.underused
              const pct = row.utilisation_pct
              // Cap the visual bar at 100% so an over-hours coach
              // doesn't break the layout, but show the real number.
              const barWidthPct = pct == null ? 0 : Math.min(pct, 100)
              return (
                <div key={row.profile_id}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium text-un1t-white truncate">{row.full_name}</span>
                    <span className={`flex-shrink-0 ${style.text}`}>
                      {row.allocated_hours}h
                      {row.contracted_hours > 0 && ` / ${row.contracted_hours}h`}
                      {pct != null && ` · ${pct}%`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-un1t-gray/40 rounded overflow-hidden">
                    <div className={`h-full ${style.bar}`} style={{ width: `${barWidthPct}%` }} />
                  </div>
                  <div className={`text-[10px] mt-0.5 ${style.text}`}>{style.label}</div>
                </div>
              )
            })}
          </div>
        )}

        {week.incompleteProfileNames.length > 0 && (
          <div className="mt-3 pt-3 border-t border-un1t-gray flex items-start gap-2 text-[11px] text-amber-200">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              Pay data missing for {week.incompleteProfileNames.slice(0, 3).join(', ')}
              {week.incompleteProfileNames.length > 3 && ` and ${week.incompleteProfileNames.length - 3} more`}
              {' — those shifts cost €0 in the budget calc.'}
            </span>
          </div>
        )}
      </div>

      {/* Contractor budget */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Wallet size={14} className="text-emerald-400" />
            Contractor spend — {monthLabel(month.monthStartIso)}
          </h3>
          {month.utilisationPct != null && (
            <span className={`text-[11px] font-medium ${month.overBudget ? 'text-red-300' : 'text-un1t-light'}`}>
              {month.utilisationPct}% of budget
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-un1t-light">Spent</div>
            <div className={`text-xl font-semibold ${month.overBudget ? 'text-red-300' : 'text-un1t-white'}`}>
              {formatEur(month.contractorCostEur)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-un1t-light">Budget</div>
            <div className="text-xl font-semibold text-un1t-white">
              {month.monthlyBudgetEur != null ? formatEur(month.monthlyBudgetEur) : <span className="text-un1t-light">Not set</span>}
            </div>
          </div>
        </div>

        {month.monthlyBudgetEur != null && (
          <>
            <div className="h-1.5 bg-un1t-gray/40 rounded overflow-hidden">
              <div
                className={`h-full ${month.overBudget ? 'bg-red-500' : month.utilisationPct >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(month.utilisationPct ?? 0, 100)}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className={month.overBudget ? 'text-red-300 font-medium' : 'text-un1t-light'}>
                {month.overBudget
                  ? <><TrendingDown size={11} className="inline mr-1" /> {formatEur(Math.abs(month.remainingEur))} over</>
                  : `${formatEur(month.remainingEur)} remaining`}
              </span>
              <span className="text-un1t-mid">FTE labour (sunk cost): {formatEur(month.fteImplicitCostEur)}</span>
            </div>
          </>
        )}

        {month.monthlyBudgetEur == null && (
          <p className="text-[11px] text-un1t-light mt-1">
            Set a monthly contractor budget in <span className="font-medium">Settings → Locations</span> to track spend against a ceiling.
          </p>
        )}
      </div>
    </div>
  )
}
