'use client'

// Performance / run-history section on the automation editor (/automations/[id]).
// Fetches the existing /stats (funnel + per-step email perf) + the new /runs
// (recent per-contact activity). Manager+ only — both endpoints 403 otherwise,
// in which case this section quietly hides. Isolated from the builder.
import { useEffect, useState } from 'react'
import { BarChart3, Users, CheckCircle2, LogOut, PauseCircle } from 'lucide-react'
import { describeNode } from '@/lib/sequences/graph'

function Chip({ icon: Icon, label, value, tone = 'text-un1t-subtle' }) {
  return (
    <div className="flex items-center gap-2 bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2">
      <Icon size={15} className={tone} />
      <span className="text-sm font-semibold text-un1t-text">{value}</span>
      <span className="text-xs text-un1t-subtle">{label}</span>
    </div>
  )
}

export default function AutomationPerformance({ sequenceId, steps = [] }) {
  const [stats, setStats] = useState(null)
  const [runs, setRuns] = useState(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [sRes, rRes] = await Promise.all([
          fetch(`/api/sequences/${sequenceId}/stats`),
          fetch(`/api/sequences/${sequenceId}/runs`),
        ])
        if (sRes.status === 403 || rRes.status === 403) { if (alive) setHidden(true); return }
        const s = await sRes.json().catch(() => ({}))
        const r = await rRes.json().catch(() => ({}))
        if (!alive) return
        if (s?.success) setStats(s.data)
        if (r?.success) setRuns(r.data?.runs || [])
      } catch {
        /* network error — leave nulls, show the empty/error state */
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [sequenceId])

  if (hidden) return null

  const stepById = new Map(steps.map((st) => [st.id, st]))
  const en = stats?.enrolments
  const exitReasons = stats?.exit_reasons || {}
  const perStep = stats?.per_step || {}

  return (
    <section className="mt-8 max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold text-un1t-text mb-1 flex items-center gap-2">
        <BarChart3 size={18} className="text-un1t-subtle" /> Performance
      </h2>
      <p className="text-xs text-un1t-subtle mb-4">How this automation has run &mdash; enrolments, per-step email results, and recent activity.</p>

      {loading && <p className="text-sm text-un1t-subtle">Loading&hellip;</p>}

      {!loading && en && (
        <>
          {/* Funnel */}
          <div className="flex flex-wrap gap-2 mb-5">
            <Chip icon={Users} label="enrolled" value={en.total} />
            <Chip icon={Users} label="active" value={en.active} tone="text-blue-600" />
            <Chip icon={CheckCircle2} label="completed" value={en.completed} tone="text-emerald-600" />
            <Chip icon={LogOut} label="exited" value={en.exited} tone="text-un1t-subtle" />
            {en.paused > 0 && <Chip icon={PauseCircle} label="paused" value={en.paused} tone="text-amber-600" />}
          </div>

          {Object.keys(exitReasons).length > 0 && (
            <p className="text-xs text-un1t-subtle mb-5">
              Exits: {Object.entries(exitReasons).map(([r, n]) => `${r.replace(/_/g, ' ')} (${n})`).join(' · ')}
            </p>
          )}

          {/* Per-step email performance */}
          {Object.keys(perStep).length > 0 && (
            <div className="bg-un1t-surface border border-un1t-border rounded-xl divide-y divide-un1t-border mb-6">
              {Object.entries(perStep).map(([stepId, m]) => {
                const st = stepById.get(stepId)
                const label = st ? describeNode({ type: st.step_type, config: st.config }).summary : 'Step'
                const isEmail = st?.step_type === 'email'
                return (
                  <div key={stepId} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-un1t-text truncate">{label}</span>
                    <span className="text-xs text-un1t-subtle shrink-0">
                      {m.sent} sent{isEmail ? ` · ${m.opened} opened · ${m.clicked} clicked` : ''}
                      {m.failed > 0 ? ` · ${m.failed} failed` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Recent activity */}
      {!loading && (
        <div>
          <h3 className="text-sm font-semibold text-un1t-text mb-2">Recent activity</h3>
          {(!runs || runs.length === 0) ? (
            <p className="text-sm text-un1t-subtle">No runs yet &mdash; this automation has not enrolled anyone.</p>
          ) : (
            <div className="bg-un1t-surface border border-un1t-border rounded-xl divide-y divide-un1t-border">
              {runs.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-un1t-text truncate">{r.contact_name}</p>
                    <p className="text-xs text-un1t-subtle">{r.outcome}{r.state === 'active' ? ` · ${r.stepLabel}` : ''}</p>
                  </div>
                  <span className="text-xs text-un1t-subtle shrink-0">{new Date(r.created_at).toLocaleDateString()}</span>
                </div>
              ))}
              {runs.length >= 50 && <p className="text-[11px] text-un1t-subtle px-4 py-2">Showing the 50 most recent.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
