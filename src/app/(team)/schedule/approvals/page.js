// /schedule/approvals — owner-only queue of draft rosters that
// need approval (manager publish over budget). Linked from the
// approval-request email and from the schedule.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, AlertTriangle, Calendar } from 'lucide-react'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import RosterApprovalActions from '@/components/RosterApprovalActions'
import { projectPublishImpact } from '@/lib/roster-publish'
import { logWarn } from '@/lib/log'

export const dynamic = 'force-dynamic'

function formatEur(n) {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
}

export default async function RosterApprovalsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Owner-or-master only — this is the approval gate.
  const isOwner = user.role === 'master' || user.role === 'owner'
  if (!MANAGER_ROLES.includes(user.role) && !isOwner) {
    redirect('/schedule')
  }

  const db = createServerClient()
  const locIds = user.role === 'master'
    ? (user.locations || []).map(l => l.id)
    : getUserLocationIds(user)

  // Fetch all draft rosters at locations the user can see.
  // RLS already filters; we still scope the query as a defence.
  const { data: drafts, error } = await db
    .from('rosters')
    .select(`
      *,
      published_by_profile:published_by(id, full_name, email),
      created_by_profile:created_by(id, full_name, email),
      locations:location_id(id, name, monthly_contractor_budget_eur)
    `)
    .eq('status', 'draft')
    .in('location_id', locIds)
    .order('created_at', { ascending: false })

  if (error) {
    return <p className="text-sm text-red-500">Failed to load approvals: {error.message}</p>
  }

  // ROSTER-FIX.4 — the overrun the owner is asked to sign off has to be the
  // overrun as it stands NOW. `projected_contractor_eur` and
  // `budget_at_publish_eur` are a snapshot taken the moment the manager hit
  // publish; every assignment added, dropped or re-timed since (and every
  // other period published into the same month) moved the real number, so
  // the card was quoting a figure that could be days stale. Re-project per
  // draft against live data instead, and fall back to the stored snapshot
  // only if the projection throws — a stale number beats an error page.
  const impacts = await Promise.all((drafts || []).map(async (d) => {
    try {
      return await projectPublishImpact(db, {
        locationId: d.location_id,
        periodStart: d.period_start,
        periodEnd: d.period_end,
      })
    } catch (e) {
      logWarn('schedule/approvals', 'live impact failed; using stored snapshot', { roster_id: d.id, err: e?.message })
      return null
    }
  }))
  const impactByRosterId = Object.fromEntries((drafts || []).map((d, i) => [d.id, impacts[i]]))

  return (
    <div>
      <Link href="/schedule" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-6">
        <ArrowLeft size={16} /> Back to Schedule
      </Link>

      <div className="mb-6">
        <h2 className="text-2xl font-bold">Roster approvals</h2>
        <p className="text-sm text-un1t-subtle mt-1">
          Drafts published over the monthly contractor budget that need an owner&apos;s sign-off.
        </p>
      </div>

      {(!drafts || drafts.length === 0) ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center">
          <Calendar size={40} className="mx-auto mb-4 text-un1t-subtle" />
          <h3 className="text-lg font-semibold mb-1">No approvals waiting</h3>
          <p className="text-sm text-un1t-subtle">All published rosters are within budget.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map(d => {
            const impact = impactByRosterId[d.id]
            const isLive = impact != null
            const projected = isLive ? impact.monthProjectedTotalEur : d.projected_contractor_eur
            const budget = isLive ? impact.monthlyBudgetEur : d.budget_at_publish_eur
            const overrun = isLive ? impact.overrunEur : (d.projected_contractor_eur || 0) - (d.budget_at_publish_eur || 0)
            const requesterRoleAtLocation = d.created_by_profile?.full_name || 'Someone'
            const canApprove = isOwner && (user.role === 'master' || user.rolesByLocation?.[d.location_id] === 'owner')
            return (
              <div key={d.id} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <AlertTriangle size={14} className="text-amber-400" />
                      {d.locations?.name || 'Location'} — {d.period_start} to {d.period_end}
                    </div>
                    <div className="text-xs text-un1t-subtle mt-1">
                      Submitted by {requesterRoleAtLocation}
                      {' · '}
                      Projected {formatEur(projected)} of {formatEur(budget)} budget
                      {overrun > 0 && <span className="text-red-700 font-medium"> ({formatEur(overrun)} over)</span>}
                      {!isLive && <span className="text-un1t-subtle"> · figure as submitted</span>}
                    </div>
                    {isLive && overrun <= 0 && (
                      <div className="text-xs text-emerald-700 mt-1">
                        Now within budget — the month has moved since this was submitted.
                      </div>
                    )}
                    {d.notes && (
                      <p className="text-xs text-un1t-subtle mt-2 italic">&ldquo;{d.notes}&rdquo;</p>
                    )}
                  </div>
                  <RosterApprovalActions rosterId={d.id} canApprove={canApprove} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
