// Server-rendered Reports view. No interactivity yet — this is a
// pure read-out of computeReportMetrics() shaped into three sections:
//
//   1. Cash position    — outstanding HMRC refund, refunded YTD,
//                         active inventory cost basis.
//   2. YTD performance  — completed-car revenue / profit / margin
//                         + this-month profit slice.
//   3. Operations       — active fleet split, avg cycle time,
//                         cost-line breakdown YTD.
//
// All EUR figures already reconcile against profitBreakdown() on the
// individual car detail pages because the same liveFxRate is passed
// through both call sites server-side.

import Link from 'next/link'
import { Banknote, TrendingUp, Activity, AlertCircle, BarChart3, Hourglass, Download } from 'lucide-react'

function fmtEur(n, opts = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: opts.precise ? 0 : 0,
  }).format(Number(n))
}
function fmtGbp(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(Number(n))
}
function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${(n * 100).toFixed(1)}%`
}
function fmtDays(n) {
  if (n == null) return '—'
  return `${n.toFixed(1)} days`
}

function MetricCard({ label, value, hint, accent }) {
  // accent: 'amber' for outstanding/owed, 'green' for positive,
  // 'red' for losses, default = neutral white.
  const valueClass =
    accent === 'amber' ? 'text-amber-400'
    : accent === 'green' ? 'text-green-500'
    : accent === 'red'   ? 'text-red-500'
    : 'text-un1t-text'

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">{label}</div>
      <div className={`text-2xl font-bold ${valueClass}`}>{value}</div>
      {hint && <div className="text-xs text-un1t-subtle mt-1">{hint}</div>}
    </div>
  )
}

function Section({ icon: Icon, title, children, action }) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-2 text-sm uppercase tracking-wider font-semibold text-un1t-subtle">
          {Icon && <Icon size={14} />}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// Pure CSS bar chart — one column per month, height proportional to
// the largest value across the series. Greys past months with zero
// activity so the user spots flat stretches at a glance.
function MonthlyBarChart({ months, valueKey, formatter }) {
  const max = months.reduce((m, x) => Math.max(m, Math.abs(x[valueKey] || 0)), 0)
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      <div className="grid grid-cols-12 gap-1.5 items-end h-40 mb-2">
        {months.map(m => {
          const v = m[valueKey] || 0
          const h = max > 0 ? Math.max(2, (Math.abs(v) / max) * 100) : 2
          const isNegative = v < 0
          return (
            <div key={m.key} className="relative flex flex-col items-center justify-end h-full" title={`${m.label}: ${formatter(v)}`}>
              <div
                className={`w-full rounded-t ${v === 0 ? 'bg-un1t-border/30' : isNegative ? 'bg-red-500/60' : 'bg-green-500/60'}`}
                style={{ height: `${h}%` }}
              />
            </div>
          )
        })}
      </div>
      <div className="grid grid-cols-12 gap-1.5">
        {months.map(m => (
          <div key={m.key} className="text-[10px] text-un1t-subtle text-center truncate">{m.label}</div>
        ))}
      </div>
    </div>
  )
}

export default function CarsReports({ metrics, error, fx }) {
  const m = metrics
  const hasData = m.fleet.activeCount > 0 || m.ytd.completedCount > 0 || m.cash.vatOutstandingCount > 0

  return (
    <div>
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3 mb-4 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!hasData ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-8 text-center">
          <p className="text-sm text-un1t-subtle">No cars yet — add one from the Active tab to start populating reports.</p>
        </div>
      ) : (
        <>
          {/* ── 1. Cash position ────────────────────────────────────── */}
          <Section icon={Banknote} title="Cash position">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <MetricCard
                label="UK VAT outstanding"
                value={fmtGbp(m.cash.vatOutstanding)}
                hint={
                  m.cash.vatOutstandingCount > 0
                    ? `${m.cash.vatOutstandingCount} car${m.cash.vatOutstandingCount === 1 ? '' : 's'} awaiting HMRC refund`
                    : 'All caught up'
                }
                accent={m.cash.vatOutstanding > 0 ? 'amber' : 'green'}
              />
              <MetricCard
                label="UK VAT refunded YTD"
                value={fmtGbp(m.cash.vatRefundedYtd)}
                hint="Received this calendar year"
                accent="green"
              />
              <MetricCard
                label="Active inventory value"
                value={fmtEur(m.cash.inventoryValueEur)}
                hint="Cost basis tied up in cars not yet sold (purchase + costs, EUR)"
              />
            </div>
          </Section>

          {/* ── 2. YTD performance ──────────────────────────────────── */}
          <Section
            icon={TrendingUp}
            title="Performance — Year to date"
            action={
              <Link
                href="/api/cars/reports/export?type=completed-ytd"
                className="text-xs inline-flex items-center gap-1 text-un1t-subtle hover:text-un1t-text"
              >
                <Download size={12} /> CSV
              </Link>
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard
                label="Cars completed"
                value={m.ytd.completedCount}
                hint={`${m.mtd.completedCount} this month`}
              />
              <MetricCard
                label="Revenue"
                value={fmtEur(m.ytd.revenue)}
                hint="Sale price (inc-VAT) on closed deals"
              />
              <MetricCard
                label="Estimated profit"
                value={fmtEur(m.ytd.profit)}
                hint={`${fmtEur(m.mtd.profit)} this month`}
                accent={m.ytd.profit >= 0 ? 'green' : 'red'}
              />
              <MetricCard
                label="Profit margin"
                value={fmtPct(m.ytd.profitMargin)}
                hint={`Avg ${fmtEur(m.ytd.avgProfitPerCar)} per car`}
              />
            </div>
          </Section>

          {/* ── 2b. Rolling 12 months ──────────────────────────────── */}
          <Section icon={BarChart3} title="Last 12 months — profit by month">
            <MonthlyBarChart months={m.monthlyPerformance || []} valueKey="profit" formatter={fmtEur} />
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl mt-3 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-un1t-border text-un1t-subtle text-[11px] uppercase tracking-wider">
                    <th className="text-left p-2.5">Month</th>
                    <th className="text-right p-2.5">Cars completed</th>
                    <th className="text-right p-2.5">Revenue</th>
                    <th className="text-right p-2.5">Profit</th>
                    <th className="text-right p-2.5">UK VAT refunded</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-un1t-border">
                  {(m.monthlyPerformance || []).slice().reverse().map(row => (
                    <tr key={row.key}>
                      <td className="p-2.5 text-un1t-text">{row.label}</td>
                      <td className="p-2.5 text-right">{row.completedCount}</td>
                      <td className="p-2.5 text-right font-mono text-un1t-text">{fmtEur(row.revenue)}</td>
                      <td className={`p-2.5 text-right font-mono ${row.profit >= 0 ? 'text-green-500' : 'text-red-500'}`}>{fmtEur(row.profit)}</td>
                      <td className="p-2.5 text-right font-mono text-un1t-subtle">{row.ukVatRefunded > 0 ? fmtGbp(row.ukVatRefunded) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ── 2c. Oldest unrefunded UK VAT ────────────────────────── */}
          {m.oldestOutstandingVat && (
            <Section
              icon={Hourglass}
              title="Oldest unrefunded UK VAT"
              action={
                <Link
                  href="/api/cars/reports/export?type=outstanding-vat"
                  className="text-xs inline-flex items-center gap-1 text-un1t-subtle hover:text-un1t-text"
                >
                  <Download size={12} /> CSV
                </Link>
              }
            >
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-5 mb-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-xs text-amber-200 uppercase tracking-wider mb-1">HMRC has been sitting on</div>
                    <div className="text-2xl font-bold text-amber-300">
                      {fmtGbp(m.oldestOutstandingVat.uk_vat)} for {m.oldestOutstandingVat.ageDays} days
                    </div>
                  </div>
                  <div className="text-xs text-amber-200">
                    <Link href={`/cars/${m.oldestOutstandingVat.car_id}`} className="underline">
                      {m.oldestOutstandingVat.uk_reg || m.oldestOutstandingVat.vin || 'Open car'}
                    </Link>
                    {' · '}
                    {[m.oldestOutstandingVat.make, m.oldestOutstandingVat.model].filter(Boolean).join(' ')}
                  </div>
                </div>
              </div>
              <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-un1t-border text-un1t-subtle text-[11px] uppercase tracking-wider">
                      <th className="text-left p-2.5">Car</th>
                      <th className="text-left p-2.5">Reg / VIN</th>
                      <th className="text-right p-2.5">UK VAT</th>
                      <th className="text-right p-2.5">Days outstanding</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-un1t-border">
                    {(m.outstandingVatList || []).map(row => (
                      <tr key={row.car_id}>
                        <td className="p-2.5">
                          <Link href={`/cars/${row.car_id}`} className="text-un1t-text hover:underline">
                            {[row.make, row.model].filter(Boolean).join(' ') || 'Car'}
                          </Link>
                        </td>
                        <td className="p-2.5 text-un1t-subtle">{row.uk_reg || row.vin || '—'}</td>
                        <td className="p-2.5 text-right font-mono text-amber-400">{fmtGbp(row.uk_vat)}</td>
                        <td className={`p-2.5 text-right ${row.ageDays > 90 ? 'text-amber-400 font-semibold' : 'text-un1t-subtle'}`}>{row.ageDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* ── 3. Operations ───────────────────────────────────────── */}
          <Section icon={Activity} title="Operations">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              <MetricCard
                label="Active fleet"
                value={m.fleet.activeCount}
                hint={`${m.fleet.newCount} new · ${m.fleet.pendingCount} pending`}
              />
              <MetricCard
                label="Avg cycle time"
                value={fmtDays(m.fleet.avgCycleDays)}
                hint="Purchase → completion (YTD closed deals)"
              />
              <MetricCard
                label="Total ancillary spend YTD"
                value={fmtEur(m.costBreakdownYtd.reduce((s, c) => s + c.totalEur, 0))}
                hint="Sum of all cost lines on completed cars"
              />
            </div>

            <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">
                Cost breakdown YTD
              </h3>
              <div className="space-y-2">
                {m.costBreakdownYtd.map(c => (
                  <div key={c.key} className="flex items-center justify-between text-sm">
                    <span className="text-un1t-text">
                      {c.label}
                      <span className="text-un1t-subtle text-xs ml-2">({c.currency})</span>
                    </span>
                    <span className="font-mono text-un1t-text">{fmtEur(c.totalEur)}</span>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        </>
      )}

      <div className="text-[11px] text-un1t-muted text-right">
        FX £→€ {fx?.rate ? fx.rate.toFixed(4) : '—'}
        {fx?.fetched_at && (
          <> · refreshed {new Date(fx.fetched_at).toLocaleString()}</>
        )}
      </div>
    </div>
  )
}
