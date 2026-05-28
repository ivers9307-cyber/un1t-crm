'use client'

// Cars list shared between the Active and Completed tabs.
//
// Active passes statuses=['new','pending'] so both kinds of in-flight
// cars appear in the same list — a per-row badge differentiates them
// at a glance. Pending rows additionally surface the outstanding-item
// count from completionGaps(). Completed passes statuses=['completed']
// alone and surfaces the completion date.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Car } from 'lucide-react'
import { estimatedProfit, completionGaps } from '@/lib/cars'

function fmtMoney(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
}

function StatusBadge({ status }) {
  const cls =
    status === 'new'       ? 'bg-blue-500/20 text-blue-400'  :
    status === 'pending'   ? 'bg-amber-500/20 text-amber-500' :
                              'bg-green-500/20 text-green-500'
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold tracking-wider ${cls}`}>
      {status}
    </span>
  )
}

export default function CarsList({ statuses, locationId, addButton, emptyText, liveFxRate = null }) {
  const [cars, setCars] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Stable cache key so useEffect re-runs only when statuses change.
  const statusKey = (Array.isArray(statuses) ? statuses : [statuses]).join(',')

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams({ status: statusKey })
    if (locationId) qs.set('location_id', locationId)
    fetch(`/api/cars?${qs}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) {
          setError(j.error || 'Failed to load')
          setCars([])
        } else {
          setCars(j.data || [])
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [statusKey, locationId])

  return (
    <div>
      {addButton}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3 mb-3">
          {error}
        </div>
      )}
      {loading && !cars.length ? (
        <p className="text-sm text-un1t-subtle">Loading…</p>
      ) : cars.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-8 text-center">
          <Car size={28} className="text-un1t-muted mx-auto mb-2" />
          <p className="text-sm text-un1t-subtle">{emptyText || 'No cars yet.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {cars.map(car => {
            const profit = estimatedProfit(car, liveFxRate)
            const gaps = car.status === 'pending' ? completionGaps(car) : []
            return (
              <Link
                key={car.id}
                href={`/cars/${car.id}`}
                className="block bg-un1t-surface border border-un1t-border rounded-2xl p-4 hover:border-un1t-muted/50 transition-colors"
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-un1t-border/40 flex items-center justify-center shrink-0">
                    <Car size={18} className="text-un1t-text" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-base font-semibold text-un1t-text">
                        {car.make || 'Tesla'} {car.model || ''}
                      </span>
                      <StatusBadge status={car.status} />
                      <span className={`text-xs ${car.uk_reg ? 'text-un1t-subtle' : 'text-un1t-muted italic'}`}>
                        UK · {car.uk_reg || 'not set'}
                      </span>
                      <span className={`text-xs ${car.irish_reg ? 'text-un1t-subtle' : 'text-un1t-muted italic'}`}>
                        IE · {car.irish_reg || 'not set'}
                      </span>
                    </div>
                    <div className="text-xs text-un1t-subtle mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      <span>UK ex-VAT {fmtMoney(car.uk_purchase_price_ex_vat)}</span>
                      <span>IE inc-VAT {fmtMoney(car.irish_sale_price_inc_vat)}</span>
                      {profit != null && (
                        <span className={profit >= 0 ? 'text-green-700 font-semibold' : 'text-red-600 font-semibold'}>
                          Est. profit {fmtMoney(profit)}
                        </span>
                      )}
                    </div>
                    {car.status === 'pending' && (
                      <div className="text-xs mt-2">
                        {gaps.length === 0 ? (
                          <span className="text-green-500">Ready to complete</span>
                        ) : (
                          <span className="text-amber-500">
                            {gaps.length} item{gaps.length === 1 ? '' : 's'} outstanding
                          </span>
                        )}
                      </div>
                    )}
                    {car.status === 'completed' && car.completed_at && (
                      <div className="text-xs text-un1t-muted mt-1">
                        Completed {new Date(car.completed_at).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
