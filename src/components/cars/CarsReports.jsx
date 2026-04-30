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

import { Banknote, TrendingUp, Activity, AlertCircle } from 'lucide-react'

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
    : 'text-un1t-white'

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5">
      <div className="text-xs uppercase tracking-wider text-un1t-light font-semibold mb-2">{label}</div>
      <div className={`text-2xl font-bold ${valueClass}`}>{value}</div>
      {hint && <div className="text-xs text-un1t-light mt-1">{hint}</div>}
    </div>
  )
}

function Section({ icon: Icon, title, children }) {
  return (
    <section className="mb-8">
      <h2 className="flex items-center gap-2 text-sm uppercase tracking-wider font-semibold text-un1t-light mb-3">
        {Icon && <Icon size={14} />}
        {title}
      </h2>
      {children}
    </section>
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
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-8 text-center">
          <p className="text-sm text-un1t-light">No cars yet — add one from the Active tab to start populating reports.</p>
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
          <Section icon={TrendingUp} title="Performance — Year to date">
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

            <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">
                Cost breakdown YTD
              </h3>
              <div className="space-y-2">
                {m.costBreakdownYtd.map(c => (
                  <div key={c.key} className="flex items-center justify-between text-sm">
                    <span className="text-un1t-white">
                      {c.label}
                      <span className="text-un1t-light text-xs ml-2">({c.currency})</span>
                    </span>
                    <span className="font-mono text-un1t-white">{fmtEur(c.totalEur)}</span>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        </>
      )}

      <div className="text-[11px] text-un1t-mid text-right">
        FX £→€ {fx?.rate ? fx.rate.toFixed(4) : '—'}
        {fx?.fetched_at && (
          <> · refreshed {new Date(fx.fetched_at).toLocaleString()}</>
        )}
      </div>
    </div>
  )
}
