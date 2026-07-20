'use client'

// REPSET-ACCOUNT.1 — Account Home (org portfolio) client surface.
//
// Renders the org header, org-level KPI tiles, and a grid of studio
// cards. Each card drills into that studio's existing CRM: "Open
// studio →" sets the active-location cookie (the exact mechanism the
// LocationSwitcher uses) and navigates to /dashboard — it does NOT
// rebuild the studio view.
//
// Presentational + one navigation side-effect; all data is computed
// server-side by src/lib/account-home.js.

import { useRouter } from 'next/navigation'
import { Building2, ArrowRight, Users, CalendarCheck, AlertTriangle } from 'lucide-react'
import { KpiCard, KpiRow } from '@/components/dashboard/Cards'

// Attention pill tones — mirrors the Business dashboard rail chip map.
// Light-theme contrast rule (CLAUDE.md): -500/10 bg + -700 text.
const ATTENTION_TONES = {
  purple: 'bg-purple-500/10 text-purple-700',
  amber: 'bg-amber-500/10 text-amber-700',
  teal: 'bg-teal-500/10 text-teal-700',
}

function AttentionPill({ attention }) {
  const cls = ATTENTION_TONES[attention?.tone] || ATTENTION_TONES.teal
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {attention?.label || 'All clear'}
    </span>
  )
}

function IntegrationChip({ connected }) {
  // Informational only — a studio with no Glofox (e.g. a placeholder
  // location) is "not connected", not an error, so no alarming tone.
  const cls = connected
    ? 'bg-teal-500/10 text-teal-700'
    : 'bg-un1t-border/40 text-un1t-subtle'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {connected ? 'Glofox' : 'No integration'}
    </span>
  )
}

function StudioMetric({ icon, label, value }) {
  return (
    <div className="flex-1">
      <div className="flex items-center gap-1 text-un1t-subtle">
        {icon}
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-xl font-bold text-un1t-text mt-0.5">{value ?? '—'}</div>
    </div>
  )
}

export default function AccountHome({ data, activeLocationId }) {
  const router = useRouter()
  const { organization, kpis, studios } = data || {}

  function openStudio(locationId) {
    // Same mechanism as LocationSwitcher — set the active-location cookie,
    // then navigate into the existing studio dashboard. The /dashboard
    // route reads the cookie server-side on the next request.
    // eslint-disable-next-line react-hooks/immutability -- document.cookie write is a user-action side-effect inside an onClick handler, not render (see LocationSwitcher.jsx).
    document.cookie = `un1t_active_location=${locationId}; path=/; max-age=${365 * 24 * 60 * 60}; SameSite=Lax`
    router.push('/dashboard')
  }

  const studioList = Array.isArray(studios) ? studios : []

  return (
    <div className="p-6 sm:p-8 max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-un1t-surface border border-un1t-border">
          <Building2 size={18} className="text-un1t-subtle" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-un1t-text">{organization?.name || 'Your account'}</h1>
          <p className="text-sm text-un1t-subtle mt-0.5">
            {kpis?.studioCount === 1
              ? '1 studio'
              : `${kpis?.studioCount || 0} studios`} · portfolio overview
          </p>
        </div>
      </div>

      <KpiRow>
        <KpiCard label="Members" value={(kpis?.members ?? 0).toLocaleString('en-IE')} />
        <KpiCard
          label="Bookings · 7d"
          value={(kpis?.bookings7d ?? 0).toLocaleString('en-IE')}
          sublabel="last 7 days"
        />
        <KpiCard
          label="At risk"
          value={(kpis?.atRiskHigh ?? 0).toLocaleString('en-IE')}
          sublabel="high-risk members"
          accent={kpis?.atRiskHigh > 0 ? 'text-amber-600' : undefined}
        />
      </KpiRow>

      <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mt-8 mb-3 px-1">
        Studios
      </h2>

      {studioList.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-6 text-center">
          <p className="text-sm text-un1t-subtle">No active studios in this account yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {studioList.map((s) => (
            <div
              key={s.id}
              className={`bg-un1t-surface border rounded-2xl p-4 flex flex-col ${
                s.id === activeLocationId ? 'border-un1t-muted/60' : 'border-un1t-border'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-un1t-text truncate">{s.name}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <AttentionPill attention={s.attention} />
                    <IntegrationChip connected={s.integrationConnected} />
                  </div>
                </div>
              </div>

              <div className="mt-4 flex gap-3">
                <StudioMetric icon={<Users size={12} />} label="Members" value={(s.members ?? 0).toLocaleString('en-IE')} />
                <StudioMetric icon={<CalendarCheck size={12} />} label="7d bookings" value={(s.bookings7d ?? 0).toLocaleString('en-IE')} />
                <StudioMetric icon={<AlertTriangle size={12} />} label="At risk" value={(s.atRiskHigh ?? 0).toLocaleString('en-IE')} />
              </div>

              <button
                type="button"
                onClick={() => openStudio(s.id)}
                className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg border border-un1t-border bg-white px-3 h-9 text-sm font-medium text-un1t-text hover:bg-un1t-border/40 transition-colors"
              >
                Open studio
                <ArrowRight size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
