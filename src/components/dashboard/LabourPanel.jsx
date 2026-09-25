// src/components/dashboard/LabourPanel.jsx
//
// LABOUR.1 — the owner's "Labour against revenue" block. Presentational and
// server-component-safe (no state, no client directive): it is rendered to HTML on
// the server by LabourBlock, so its props never travel to the browser as data.
// The view model (src/lib/labour-month-model.js) carries totals, ratios, hours
// and names only.

const REASONS = {
  no_salary: 'no salary',
  inactive_employee: 'deactivated employee',
  no_rate: 'no hourly rate',
  unknown_type: 'no employment type',
  unknown_person: 'profile not found',
}

// Review 3 — why a studio is left out of the total's ratio.
const EXCLUDED = {
  none: 'no revenue tracked there',
  unavailable: 'revenue could not be read',
}

function euros(cents) {
  if (cents == null) return '—'
  return `€${Math.round(cents / 100).toLocaleString('en-IE')}`
}

function pctLabel(p) {
  return p == null ? null : `${p.toFixed(1)}%`
}

function revenueLine(row) {
  if (row.revenue_status === 'tracked') {
    const only = row.ratio_base ? `, ${row.ratio_base.studios.join(' and ')} only` : ''
    return `${euros(row.mrr_cents)}/month recurring (MRR), ${row.recurring_members} members${only}`
  }
  if (row.revenue_status === 'unavailable') return 'Could not be read'
  return 'Not tracked here'
}

// Review 2 — "33.4% on UN1T Stillorgan: €3,340 of €10,000 MRR": a ratio over
// SOME of the studios is printed with its base, never beside the total's euros.
function baseLine(pct, studios, costCents, revenueCents, suffix) {
  return `${pctLabel(pct)} on ${studios.join(' and ')}: ${euros(costCents)} of ${euros(revenueCents)} ${suffix}`
}

function StudioLabour({ row, isTotal = false }) {
  const base = isTotal ? row.ratio_base : null
  const f = base ? null : pctLabel(row.forecast_pct)
  const a = base ? null : pctLabel(row.actual_pct)
  return (
    <div className={`rounded-md border border-un1t-border px-3 py-2 ${isTotal ? 'bg-un1t-bg' : ''}`}>
      <p className="text-sm font-medium text-un1t-text">{row.name}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-un1t-muted">Forecast, whole month</dt>
        <dd className="text-un1t-text">
          <span className="font-semibold">{euros(row.forecast.cost_cents)}</span>
          {f ? ` · ${f} of revenue` : ''} · {row.forecast.hours}h
        </dd>
        <dt className="text-un1t-muted">So far</dt>
        <dd className="text-un1t-text">
          <span className="font-semibold">{euros(row.actual.cost_cents)}</span>
          {a ? ` · ${a} of revenue to date` : ''} · {row.actual.hours}h
        </dd>
        {base && row.forecast_pct != null ? (
          <>
            <dt className="text-un1t-muted">Forecast share</dt>
            <dd className="text-un1t-text">{baseLine(row.forecast_pct, base.studios, base.forecast_cost_cents, row.mrr_cents, 'MRR')}</dd>
          </>
        ) : null}
        {base && row.actual_pct != null ? (
          <>
            <dt className="text-un1t-muted">So far share</dt>
            <dd className="text-un1t-text">{baseLine(row.actual_pct, base.studios, base.actual_cost_cents, row.revenue_to_date_cents, 'to date')}</dd>
          </>
        ) : null}
        <dt className="text-un1t-muted">Revenue</dt>
        <dd className="text-un1t-text">{revenueLine(row)}</dd>
        <dt className="text-un1t-muted">Forecast split</dt>
        <dd className="text-un1t-text">
          employees {euros(row.forecast.employees_cents)} · contractors {euros(row.forecast.contractors_cents)}
        </dd>
      </dl>
      {row.draft_hours > 0 ? (
        <p className="mt-1 text-xs text-un1t-muted">{row.draft_hours}h in draft rosters not counted</p>
      ) : null}
      {isTotal && row.ratio_excludes?.length > 0 ? (
        <p className="mt-1 text-xs text-un1t-muted">
          {row.revenue_status === 'tracked' ? 'Ratios leave out' : 'No ratio:'}{' '}
          {row.ratio_excludes.map((x) => `${x.name} (${EXCLUDED[x.status] || EXCLUDED.none})`).join(', ')}.
        </p>
      ) : null}
    </div>
  )
}

export function LabourPanel({ vm }) {
  // Review nit — a salaried person with nowhere to charge the salary (no
  // published hours and no active studio in any organisation) has pay on file;
  // they get their own line.
  const noStudio = vm.uncosted.filter((u) => u.reason === 'no_studio')
  const noPay = vm.uncosted.filter((u) => u.reason !== 'no_studio')
  return (
    <section aria-labelledby="labour-heading" className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="labour-heading" className="text-sm font-semibold text-un1t-text">
          Labour against revenue · {vm.month_label}
        </h2>
        <span className="text-xs text-un1t-muted">Day {vm.day_of_month} of {vm.days_in_month} · owners only</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {vm.studios.map((row) => <StudioLabour key={row.location_id} row={row} />)}
        {vm.total ? <StudioLabour row={vm.total} isTotal /> : null}
      </div>
      {noPay.length > 0 ? (
        <p className="mt-3 text-xs text-amber-700">
          No pay on file, so not counted: {noPay.map((u) => `${u.name} (${u.hours}h, ${REASONS[u.reason] || 'not costed'})`).join(', ')}.
        </p>
      ) : null}
      {noStudio.length > 0 ? (
        <p className="mt-1 text-xs text-amber-700">
          Salary not counted (no active studio): {noStudio.map((u) => u.name).join(', ')}.
        </p>
      ) : null}
      {vm.untimed_shifts > 0 ? (
        <p className="mt-1 text-xs text-amber-700">
          {vm.untimed_shifts} published shift{vm.untimed_shifts === 1 ? ' has' : 's have'} no times and {vm.untimed_shifts === 1 ? 'is' : 'are'} not counted.
        </p>
      ) : null}
      <p className="mt-3 text-xs text-un1t-subtle">
        Revenue is the recurring membership base billing now (the Studio scorecard&apos;s MRR), pro-rated to today for
        &quot;so far&quot;. Class packs, drop-ins and one-off charges are not in it. Forecast is the published roster for
        the whole month. Salaries count in full (a twelfth a month, pro-rated to today for &quot;so far&quot;), split
        between their studios in every organisation by rostered hours (equally when not rostered); this block
        counts only these studios&apos; share. Contractors count per rostered hour at their rate, admin shifts included.
      </p>
    </section>
  )
}
