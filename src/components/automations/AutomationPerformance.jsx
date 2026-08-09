'use client'

// Performance / run-history section on the automation editor (/automations/[id]).
// Fetches /stats (funnel + per-step results) + /runs (the per-contact roster).
// Manager+ only — both endpoints 403 otherwise, in which case this section
// quietly hides. Isolated from the builder.
//
// Auto-refreshes every 30s while the tab is visible (operators sit on this
// page watching a test run move through the flow), plus a manual Refresh.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  BarChart3, Users, CheckCircle2, LogOut, PauseCircle, RefreshCw, Clock, UserPlus, Play,
} from 'lucide-react'
import { describeNode } from '@/lib/sequences/graph'
import { describeNextStep } from '@/lib/sequences/run-history'

// Friendly labels for sequence_enrollments.source_type (how they got in).
const SOURCE_LABELS = {
  contact_created: 'New lead',
  manual: 'Manual enrolment',
  booking_created: 'Booking',
  first_booking: 'First booking',
  tag_added: 'Tag added',
  pipeline_stage_change: 'Stage change',
  segment_added: 'Segment',
  segment_removed: 'Left segment',
  membership_state_change: 'Membership change',
  achievement_unlocked: 'Achievement',
  event_reminder: 'Event reminder',
  webhook: 'Webhook',
  anniversary: 'Anniversary',
  inactivity: 'Inactivity',
}
const sourceLabel = (s) => SOURCE_LABELS[s] || (s ? s.replace(/_/g, ' ') : '—')

// Friendly labels for sequence_enrollments.exit_reason (why they left).
// The /stats route groups by this column and it is FREE TEXT, so the map
// can never be exhaustive — anything unmapped still renders legibly.
const EXIT_REASON_LABELS = {
  goal_met: 'Goal met',
  // SEQEXIT.1 — the audience filter is re-checked before every step.
  left_audience: 'No longer matched the audience',
  unsubscribed: 'Unsubscribed',
  unspecified: 'Unspecified',
}
export const exitReasonLabel = (r) =>
  EXIT_REASON_LABELS[r] || (r ? r.replace(/_/g, ' ') : 'Unspecified')

// Light-theme status ramps (-700 text per the palette convention).
const STATUS_CHIP = {
  active: 'bg-blue-500/15 text-blue-700',
  completed: 'bg-emerald-500/15 text-emerald-700',
  exited: 'bg-gray-500/15 text-gray-600',
  paused: 'bg-amber-500/15 text-amber-700',
}

function fmtWhen(v) {
  if (!v) return ''
  return new Date(v).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function Stat({ icon: Icon, label, value, tone = 'text-un1t-subtle' }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-un1t-subtle mb-1">
        <Icon size={14} className={tone} /> {label}
      </div>
      <p className="text-2xl font-bold text-un1t-text leading-none">{value}</p>
    </div>
  )
}

// What an active enrolment is doing right now. The runner ticks every 5
// minutes, so an overdue next step means "on the next tick", not stuck.
function NextStepNote({ run }) {
  if (run.state !== 'active') return null
  const d = describeNextStep(run.next_step_at, Date.now())
  if (!d) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs text-un1t-subtle">
      <Clock size={11} />
      {d.overdue
        ? 'next step due now — runs on the next tick (≤5 min)'
        : d.minutes < 60
          ? `next step in ~${d.minutes} min`
          : `next step ${fmtWhen(run.next_step_at)}`}
    </span>
  )
}

export default function AutomationPerformance({ sequenceId, steps = [] }) {
  const [stats, setStats] = useState(null)
  const [runs, setRuns] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [resumingId, setResumingId] = useState(null)
  const [resumeError, setResumeError] = useState(null)
  const aliveRef = useRef(true)

  const load = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [sRes, rRes] = await Promise.all([
        fetch(`/api/sequences/${sequenceId}/stats`),
        fetch(`/api/sequences/${sequenceId}/runs`),
      ])
      if (sRes.status === 403 || rRes.status === 403) { if (aliveRef.current) setHidden(true); return }
      const s = await sRes.json().catch(() => ({}))
      const r = await rRes.json().catch(() => ({}))
      if (!aliveRef.current) return
      if (s?.success) setStats(s.data)
      if (r?.success) setRuns(r.data?.runs || [])
    } catch {
      /* network error — keep whatever we have */
    } finally {
      if (aliveRef.current) { setLoading(false); setRefreshing(false) }
    }
  }, [sequenceId])

  // SEQ-RESUME.1 — put a paused (MAX_ERRORS) enrollment back into the flow.
  // The route CAS-es on status='paused', so a double-click or a concurrent
  // resume comes back 409 — treated as "already resumed", not an error.
  const resume = useCallback(async (enrollmentId) => {
    setResumingId(enrollmentId)
    setResumeError(null)
    try {
      const res = await fetch(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 409 && aliveRef.current) {
        setResumeError(j?.error || 'Resume failed')
      }
    } catch {
      if (aliveRef.current) setResumeError('Resume failed — network error')
    } finally {
      if (aliveRef.current) setResumingId(null)
      await load(true)
    }
  }, [sequenceId, load])

  useEffect(() => {
    aliveRef.current = true
    load(false)
    // Light poll so a test run visibly advances without manual reloads.
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load(true)
    }, 30000)
    return () => { aliveRef.current = false; clearInterval(t) }
  }, [load])

  if (hidden) return null

  const stepById = new Map(steps.map((st) => [st.id, st]))
  const en = stats?.enrolments
  const exitReasons = stats?.exit_reasons || {}
  const perStep = stats?.per_step || {}

  return (
    <section className="mt-10 max-w-6xl mx-auto px-4 pb-10">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-un1t-text flex items-center gap-2">
          <BarChart3 size={18} className="text-un1t-subtle" /> Performance
        </h2>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      <p className="text-xs text-un1t-subtle mb-4">
        Who&apos;s in this automation and where they are — refreshes automatically every 30 seconds.
      </p>

      {loading && <p className="text-sm text-un1t-subtle">Loading&hellip;</p>}

      {!loading && en && (
        <>
          {/* Funnel */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Stat icon={Users} label="Enrolled (all time)" value={en.total} />
            <Stat icon={Users} label="Active now" value={en.active} tone="text-blue-600" />
            <Stat icon={CheckCircle2} label="Completed" value={en.completed} tone="text-emerald-600" />
            <Stat icon={LogOut} label="Exited" value={en.exited} tone="text-un1t-subtle" />
            {en.paused > 0 && <Stat icon={PauseCircle} label="Paused (errors)" value={en.paused} tone="text-amber-600" />}
          </div>

          {Object.keys(exitReasons).length > 0 && (
            <p className="text-xs text-un1t-subtle mb-6">
              Exits: {Object.entries(exitReasons).map(([r, n]) => `${exitReasonLabel(r)} (${n})`).join(' · ')}
            </p>
          )}
        </>
      )}

      {/* Enrolled contacts — the per-person run log */}
      {!loading && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-un1t-text mb-2 flex items-center gap-1.5">
            <UserPlus size={14} className="text-un1t-subtle" /> Enrolled contacts
          </h3>
          {resumeError && (
            <p className="text-xs text-red-700 bg-red-500/10 rounded-lg px-3 py-2 mb-2">{resumeError}</p>
          )}
          {(!runs || runs.length === 0) ? (
            <div className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-6 text-center">
              <p className="text-sm text-un1t-subtle">
                No one has enrolled yet — contacts appear here the moment the trigger fires.
              </p>
            </div>
          ) : (
            <div className="bg-un1t-surface border border-un1t-border rounded-xl divide-y divide-un1t-border">
              {runs.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    {r.contact_id ? (
                      <Link href={`/contacts/${r.contact_id}`} className="text-sm font-medium text-un1t-text hover:underline truncate inline-block max-w-full align-bottom">
                        {r.contact_name}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium text-un1t-text truncate">{r.contact_name}</p>
                    )}
                    <p className="text-xs text-un1t-subtle truncate">
                      {sourceLabel(r.source_type)} · enrolled {fmtWhen(r.enrolled_at)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 text-right shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-un1t-subtle">
                        {r.state === 'active' ? r.stepLabel : r.outcome}
                      </span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${STATUS_CHIP[r.state] || 'bg-gray-500/15 text-gray-600'}`}>
                        {r.state}
                      </span>
                    </div>
                    <NextStepNote run={r} />
                    {r.state === 'paused' && r.outcome?.startsWith('Paused:') && (
                      <span className="text-xs text-amber-700 max-w-xs truncate" title={r.outcome}>{r.outcome}</span>
                    )}
                    {r.state === 'paused' && (
                      <button
                        type="button"
                        onClick={() => resume(r.id)}
                        disabled={resumingId === r.id}
                        className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        <Play size={10} /> {resumingId === r.id ? 'Resuming…' : 'Resume'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {runs.length >= 50 && <p className="text-[11px] text-un1t-subtle px-4 py-2">Showing the 50 most recent.</p>}
            </div>
          )}
        </div>
      )}

      {/* Per-step results */}
      {!loading && Object.keys(perStep).length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-un1t-text mb-2">Per-step results</h3>
          <div className="bg-un1t-surface border border-un1t-border rounded-xl divide-y divide-un1t-border">
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
        </div>
      )}
    </section>
  )
}
