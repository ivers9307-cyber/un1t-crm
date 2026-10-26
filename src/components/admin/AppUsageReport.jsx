'use client'

// USAGE.1 — the App usage report (platform console, /admin/app-usage), laid
// out as Richard approved it on 26 Oct 2026: filters, four summary cards, a
// "Who" table that flips to "By feature", and for a chosen person their
// features plus one day's sessions as a timeline whose bars list the feature
// trail. Reads /api/admin/app-usage and /api/admin/app-usage/[profileId].

import { useEffect, useMemo, useState } from 'react'
import { Card, Table, Loading } from '@/components/ui'
import { todayStrIn, PLATFORM_TZ } from '@shared/zoned-time'
import { formatDuration, formatLastActive, formatPerDay, timelineBars } from '@/lib/app-usage/format'

const RANGES = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '12m', label: 'Last 12 months' },
]
const PLATFORMS = [
  { value: 'all', label: 'Phone and web' },
  { value: 'phone', label: 'Phone' },
  { value: 'web', label: 'Web' },
]
const BAR_CLASS = { phone: 'bg-un1t-accent', web: 'bg-violet-500' }
const SELECT = 'rounded-md border border-un1t-border bg-un1t-surface px-2 py-1.5 text-sm text-un1t-text'

function query(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  return q.toString()
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) throw new Error(body?.error || `HTTP ${res.status}`)
  return body.data
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg bg-un1t-surface border border-un1t-border px-4 py-3">
      <div className="text-xs text-un1t-muted">{label}</div>
      <div className="text-xl font-semibold text-un1t-text">{value}</div>
    </div>
  )
}

function phoneWebLabel(row) {
  if (row.phoneShare == null) return '—'
  const phone = Math.round(row.phoneShare * 100)
  return `${phone}% / ${100 - phone}%`
}

export default function AppUsageReport() {
  const [range, setRange] = useState('7d')
  const [platform, setPlatform] = useState('all')
  const [organizationId, setOrganizationId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [view, setView] = useState('people')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  const filters = { range, platform, organization_id: organizationId, location_id: locationId }

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    getJson(`/api/admin/app-usage?${query({ ...filters, view })}`)
      .then((d) => { if (live) setData(d) })
      .catch((e) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, platform, organizationId, locationId, view])

  const locations = useMemo(
    () => (data?.locations || []).filter((l) => !organizationId || l.organization_id === organizationId),
    [data, organizationId],
  )
  const showTenant = !organizationId && (data?.organizations || []).length > 1
  const totals = data?.totals

  const peopleColumns = [
    {
      key: 'name',
      header: 'Person',
      render: (r) => (
        <span className={r.seconds > 0 ? 'text-un1t-text font-medium' : 'text-un1t-muted'}>{r.name}</span>
      ),
    },
    ...(showTenant ? [{ key: 'tenant', header: 'Tenant', render: (r) => r.tenant || '—' }] : []),
    { key: 'last', header: 'Last active', render: (r) => formatLastActive(r.lastActiveAt, Date.now(), PLATFORM_TZ) },
    { key: 'days', header: 'Days used', align: 'right', render: (r) => `${r.daysUsed} / ${data?.range?.days ?? ''}` },
    { key: 'spd', header: 'Sessions / day', align: 'right', render: (r) => formatPerDay(r.sessionsPerDay) },
    { key: 'time', header: 'Total time', align: 'right', render: (r) => formatDuration(r.seconds) },
    { key: 'split', header: 'Phone / web', align: 'right', render: phoneWebLabel },
  ]
  const featureColumns = [
    { key: 'label', header: 'Feature', render: (r) => <span className="font-medium text-un1t-text">{r.label}</span> },
    { key: 'people', header: 'People', align: 'right', accessor: 'people' },
    { key: 'vpd', header: 'Visits / day', align: 'right', render: (r) => formatPerDay(r.visitsPerDay) },
    { key: 'avg', header: 'Avg visit', align: 'right', render: (r) => formatDuration(r.avgVisitSec) },
    { key: 'time', header: 'Total time', align: 'right', render: (r) => formatDuration(r.seconds) },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Date range" className={SELECT} value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <select aria-label="Platform" className={SELECT} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select
          aria-label="Tenant"
          className={SELECT}
          value={organizationId}
          onChange={(e) => { setOrganizationId(e.target.value); setLocationId(''); setSelected(null) }}
        >
          <option value="">All tenants</option>
          {(data?.organizations || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select aria-label="Studio" className={SELECT} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">All studios</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="Active staff" value={`${totals.activeStaff} / ${totals.staffCount}`} />
          <Metric label="Sessions" value={totals.sessions} />
          <Metric label="Time in app" value={formatDuration(totals.seconds)} />
          <Metric label="Top feature" value={totals.topFeature || '—'} />
        </div>
      )}

      <Card
        padding="none"
        title={<span className="px-4 pt-4 inline-block">{view === 'people' ? 'Who' : 'By feature'}</span>}
        actions={(
          <div className="flex gap-1 px-4 pt-4" role="group" aria-label="Group by">
            {[['people', 'Who'], ['features', 'By feature']].map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1 text-sm border ${view === v ? 'border-un1t-text text-un1t-text bg-un1t-bg' : 'border-un1t-border text-un1t-subtle'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      >
        <Table
          className="overflow-x-auto"
          loading={loading && !data}
          columns={view === 'people' ? peopleColumns : featureColumns}
          rows={data?.view === view ? data.rows : []}
          rowKey={(r) => r.profileId || r.feature}
          onRowClick={view === 'people' ? (r) => setSelected(r) : undefined}
          empty="No app usage recorded in this range yet."
        />
      </Card>

      {view === 'people' && selected && (
        <PersonDetail person={selected} filters={filters} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

function PersonDetail({ person, filters, onClose }) {
  const [day, setDay] = useState(() => todayStrIn(PLATFORM_TZ))
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [openSession, setOpenSession] = useState(null)

  useEffect(() => {
    let live = true
    setError(null)
    getJson(`/api/admin/app-usage/${person.profileId}?${query({ ...filters, day })}`)
      .then((d) => { if (live) setDetail(d) })
      .catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.profileId, day, filters.range, filters.platform, filters.organization_id, filters.location_id])

  const strip = useMemo(
    () => timelineBars(detail?.timeline || [], day, PLATFORM_TZ),
    [detail, day],
  )
  const maxSeconds = Math.max(1, ...(detail?.features || []).map((f) => f.seconds))
  const trail = (detail?.timeline || []).find((s) => s.sessionId === openSession)

  return (
    <Card
      title={`${person.name} by feature`}
      actions={<button type="button" onClick={onClose} className="text-sm text-un1t-subtle">Close</button>}
    >
      {error && <p className="text-sm text-red-700">{error}</p>}
      {!detail && !error && <Loading />}
      {detail && (
        <div className="space-y-6">
          <Table
            columns={[
              { key: 'label', header: 'Feature', render: (r) => <span className="font-medium text-un1t-text">{r.label}</span> },
              { key: 'vpd', header: 'Visits / day', align: 'right', render: (r) => formatPerDay(r.visitsPerDay) },
              { key: 'avg', header: 'Avg visit', align: 'right', render: (r) => formatDuration(r.avgVisitSec) },
              { key: 'time', header: 'Total time', align: 'right', render: (r) => formatDuration(r.seconds) },
              {
                key: 'share',
                header: 'Share',
                render: (r) => (
                  <div className="h-1.5 rounded bg-un1t-accent" style={{ width: `${Math.round((r.seconds / maxSeconds) * 100)}%` }} />
                ),
              },
            ]}
            rows={detail.features}
            rowKey={(r) => r.feature}
            empty="No feature use in this range."
          />

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-un1t-text">{person.name} timeline</h4>
              <input
                type="date"
                aria-label="Day"
                className={SELECT}
                value={day}
                max={todayStrIn(PLATFORM_TZ)}
                onChange={(e) => { if (e.target.value) { setDay(e.target.value); setOpenSession(null) } }}
              />
            </div>
            {!detail.timelineAvailable ? (
              <p className="text-sm text-un1t-subtle">Session detail is kept for 90 days. Pick a more recent day.</p>
            ) : detail.timeline.length === 0 ? (
              <p className="text-sm text-un1t-subtle">No sessions on this day.</p>
            ) : (
              <>
                <div className="relative h-9 rounded-md bg-un1t-bg border border-un1t-border">
                  {strip.bars.map((b) => (
                    <button
                      key={b.sessionId}
                      type="button"
                      aria-label={`${b.platform} session, ${formatLastActive(b.startedAt, Date.now(), PLATFORM_TZ)}`}
                      onClick={() => setOpenSession(b.sessionId === openSession ? null : b.sessionId)}
                      className={`absolute top-1.5 bottom-1.5 rounded ${BAR_CLASS[b.platform]} ${openSession === b.sessionId ? 'ring-2 ring-un1t-text' : ''}`}
                      style={{ left: `${b.left}%`, width: `${b.width}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-un1t-muted mt-1">
                  <span>{String(strip.startHour).padStart(2, '0')}:00</span>
                  <span>{String(strip.endHour % 24).padStart(2, '0')}:00</span>
                </div>
                <p className="text-xs text-un1t-subtle mt-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-un1t-accent align-middle mr-1" />Phone
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-violet-500 align-middle ml-3 mr-1" />Web
                  <span className="ml-3">Each bar is one session. Tap it to see the features in order.</span>
                </p>
                {trail && (
                  <div className="mt-3 text-sm text-un1t-text">
                    <span className="text-un1t-subtle mr-2 capitalize">{trail.platform}</span>
                    {trail.trail.length === 0
                      ? <span className="text-un1t-subtle">No feature visits recorded.</span>
                      : trail.trail.map((t, i) => (
                        <span key={`${t.feature}-${i}`}>
                          {i > 0 && <span className="text-un1t-muted mx-1">→</span>}
                          {t.label} {formatDuration(t.seconds)}
                        </span>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
