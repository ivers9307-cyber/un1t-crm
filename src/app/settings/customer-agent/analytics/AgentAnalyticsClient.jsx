'use client'

// RADAR-AGENT — agent analytics / "needs review" feed (plan §4e).
// Manager+ operator screen: headline numbers, containment rate,
// most-asked topics, and the list of conversations the agent escalated
// (each links to its channel inbox). Read-only; trailing-window.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ChevronLeft, Bot, TrendingUp, MessageCircle, UserCheck, ArrowUpRight, CalendarCheck, Ban, Send, Hourglass } from 'lucide-react'

const WINDOWS = [7, 30, 90]
const TOPIC_LABELS = {
  sales: 'Sales', account: 'Account', pause: 'Pauses',
  cancellation: 'Cancellations', hours: 'Opening hours', other: 'Other',
}

function Stat({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-un1t-subtle mb-1">
        {Icon && <Icon size={14} />}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-2xl font-bold text-un1t-text">{value}</div>
      {sub && <div className="text-xs text-un1t-muted mt-0.5">{sub}</div>}
    </div>
  )
}

export default function AgentAnalyticsClient() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/agent/analytics?days=${days}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.success) { setData(d); setError(null) } else setError(d.error || 'Failed to load')
      })
      .catch(() => { if (!cancelled) setError('Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days])

  const c = data?.combined
  const contain = data?.containment_rate

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/settings/customer-agent" className="inline-flex items-center gap-1 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ChevronLeft size={16} /> Customer agent
      </Link>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-bold">Agent activity</h2>
        <div className="flex gap-1">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${days === w ? 'bg-un1t-text text-un1t-bg font-semibold' : 'bg-un1t-surface text-un1t-subtle hover:text-un1t-text'}`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        How the customer agent is doing across WhatsApp + Instagram — your early-warning feed. Last {days} days.
      </p>

      {loading ? (
        <p className="text-sm text-un1t-subtle">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            <Stat icon={Bot} label="Agent replies" value={c.agent_replies} sub={`${c.agent_handled} conversations`} />
            <Stat icon={TrendingUp} label="Contained" value={contain == null ? '—' : `${contain}%`} sub="handled without a human" />
            <Stat icon={UserCheck} label="Escalated" value={c.escalated} sub="handed to a human" />
            <Stat icon={MessageCircle} label="Inbound" value={c.inbound_total} sub={`${c.verified} identity-verified`} />
          </div>

          {/* AGENT-ANALYTICS.2 — outcomes: what the agent actually did */}
          {data.actions && (
            <>
              <h3 className="text-sm font-semibold text-un1t-text mb-3">Outcomes</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
                <Stat icon={CalendarCheck} label="Bookings made" value={data.actions.bookings} sub="classes, events, consultations" />
                <Stat icon={Ban} label="Cancellations" value={data.actions.cancellations} sub="processed" />
                <Stat icon={Hourglass} label="Awaiting approval" value={data.actions.pending_approvals} sub="in /approvals now" />
                <Stat icon={Send} label="Follow-ups sent" value={data.actions.followups_sent} sub="proactive nudges" />
                <Stat icon={Send} label="Check-ins sent" value={data.actions.checkins_sent} sub="after first class" />
              </div>
            </>
          )}

          {/* MIA-BOARD.4 — the nightly reviewer's flagged conversations:
              the threads a manager should actually read, worst first. */}
          {data.flagged_reviews && data.flagged_reviews.length > 0 && (
            <section className="mb-8">
              <h3 className="text-sm font-semibold text-un1t-text mb-2">Flagged conversations</h3>
              <div className="space-y-1.5">
                {data.flagged_reviews.map((r, i) => {
                  const href = r.channel === 'instagram'
                    ? `/communications/inbox?c=${r.conversation_id}&ch=ig`
                    : `/communications/inbox?c=${r.conversation_id}`
                  return (
                    <Link
                      key={`${r.channel}-${r.conversation_id}-${i}`}
                      href={href}
                      className="block bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2 text-sm hover:border-un1t-subtle transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-un1t-text">
                          {r.score != null ? `${r.score}/5` : 'flagged'}
                          {(r.flags || []).length > 0 && (
                            <span className="ml-2 text-xs text-amber-700">{r.flags.join(' · ')}</span>
                          )}
                        </span>
                        <span className="flex items-center gap-1 text-xs text-un1t-subtle">
                          {r.channel} · {r.review_date}
                          <ArrowUpRight size={12} />
                        </span>
                      </div>
                      {r.summary && <p className="text-xs text-un1t-muted mt-0.5">{r.summary}</p>}
                      {r.worst_quote && <p className="text-xs text-un1t-subtle italic mt-0.5">&ldquo;{r.worst_quote}&rdquo;</p>}
                    </Link>
                  )
                })}
              </div>
              <p className="text-xs text-un1t-subtle mt-2">
                Reviewed nightly against the agent rubric. Recurring flags usually mean a missing Knowledge entry or Extra rule.
              </p>
            </section>
          )}

          {/* MIA-BOARD.4 — handoff reasons in the agent's own words: the
              knowledge-gap detector. */}
          {data.handoff_reasons && data.handoff_reasons.length > 0 && (
            <section className="mb-8">
              <h3 className="text-sm font-semibold text-un1t-text mb-2">Why Mia handed off</h3>
              <ul className="space-y-1.5">
                {data.handoff_reasons.map((h, i) => {
                  const href = h.channel === 'instagram'
                    ? `/communications/inbox?c=${h.conversation_id}&ch=ig`
                    : `/communications/inbox?c=${h.conversation_id}`
                  return (
                    <li key={i} className="text-sm text-un1t-text flex items-start gap-2">
                      <span className="shrink-0 text-un1t-subtle">→</span>
                      <span className="flex-1">
                        {h.reason}
                        <Link href={href} className="text-xs text-un1t-subtle ml-2 hover:text-un1t-text">
                          {new Date(h.created_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })} ↗
                        </Link>
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="text-xs text-un1t-subtle mt-2">
                A reason that keeps recurring is a Knowledge entry waiting to be written.
              </p>
            </section>
          )}

          {/* AGENT-QA.1 — inbox thumbs feedback */}
          {data.feedback && (data.feedback.up + data.feedback.down > 0) && (
            <section className="mb-8">
              <h3 className="text-sm font-semibold text-un1t-text mb-2">
                Quality feedback <span className="text-un1t-muted font-normal">— 👍 {data.feedback.up} · 👎 {data.feedback.down}</span>
              </h3>
              {data.feedback.recent_downs.length === 0 ? (
                <p className="text-sm text-un1t-muted">No negative feedback in this window. 🎉</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.feedback.recent_downs.map((f, i) => (
                    <li key={i} className="text-sm text-un1t-text flex items-start gap-2">
                      <span className="shrink-0">👎</span>
                      <span className="flex-1">
                        {f.note || <span className="text-un1t-muted italic">no note</span>}
                        <span className="text-xs text-un1t-subtle ml-2">
                          {f.channel} · {new Date(f.created_at).toLocaleDateString('en-IE')}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-un1t-subtle mt-2">
                Turn recurring complaints into Knowledge entries or Extra rules in agent settings.
              </p>
            </section>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            {/* Most-asked topics */}
            <section>
              <h3 className="text-sm font-semibold text-un1t-text mb-3">What customers asked</h3>
              {(!data.topics || data.topics.length === 0) ? (
                <p className="text-sm text-un1t-muted">No inbound messages in this window.</p>
              ) : (
                <div className="space-y-2">
                  {data.topics.map(({ topic, count }) => {
                    const max = data.topics[0].count || 1
                    return (
                      <div key={topic}>
                        <div className="flex justify-between text-xs text-un1t-subtle mb-0.5">
                          <span>{TOPIC_LABELS[topic] || topic}</span><span>{count}</span>
                        </div>
                        <div className="h-1.5 bg-un1t-border rounded-full overflow-hidden">
                          <div className="h-full bg-un1t-accent rounded-full" style={{ width: `${Math.round((count / max) * 100)}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Escalations to review */}
            <section>
              <h3 className="text-sm font-semibold text-un1t-text mb-3">Escalated — review these</h3>
              {(!data.escalations || data.escalations.length === 0) ? (
                <p className="text-sm text-un1t-muted">Nothing escalated in this window. 🎉</p>
              ) : (
                <div className="space-y-1.5">
                  {data.escalations.map(e => {
                    const href = e.channel === 'instagram'
                      ? `/communications/inbox?c=${e.id}&ch=ig`
                      : `/communications/inbox?c=${e.id}`
                    return (
                      <Link
                        key={`${e.channel}-${e.id}`}
                        href={href}
                        className="flex items-center justify-between bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2 text-sm hover:border-un1t-subtle transition-colors"
                      >
                        <span className="capitalize text-un1t-text">{e.channel}</span>
                        <span className="flex items-center gap-1 text-xs text-un1t-subtle">
                          {new Date(e.handed_off_at).toLocaleDateString('en-IE', { month: 'short', day: 'numeric' })}
                          <ArrowUpRight size={12} />
                        </span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
