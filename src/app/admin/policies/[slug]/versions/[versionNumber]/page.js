// /admin/policies/[slug]/versions/[versionNumber] — admin per-version
// view showing the body, the list of staff who've opened (and how
// many sessions / how long), the staff who haven't, and the "hot
// sections" aggregate (which sections people spent the longest on
// collectively).
//
// POLICIES-VIEWS.1 — replaces the previous acknowledgement-based
// report.

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft, Eye, AlertCircle, Flame } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listVersionViewers, sectionDwellAggregate } from '@/lib/policies'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner' || user?.profileRole === 'master'
}

function fmtDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(secs) {
  if (!secs || secs <= 0) return '0s'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m === 0) return `${s}s`
  if (s === 0) return `${m}m`
  return `${m}m ${s}s`
}

export default async function AdminPolicyVersionPage({ params }) {
  const { slug, versionNumber } = await params
  const versionNum = parseInt(versionNumber, 10)
  if (!Number.isFinite(versionNum) || versionNum < 1) notFound()

  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  const { data: policy } = await db
    .from('policies')
    .select('id, slug, title')
    .eq('slug', slug)
    .maybeSingle()
  if (!policy) notFound()

  const { data: version } = await db
    .from('policy_versions')
    .select('id, version_number, body_markdown, change_summary, effective_date, published_at, is_current')
    .eq('policy_id', policy.id)
    .eq('version_number', versionNum)
    .maybeSingle()
  if (!version) notFound()

  const [{ viewers, outstanding }, hotSections] = await Promise.all([
    listVersionViewers(version.id),
    sectionDwellAggregate(version.id),
  ])

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <Link href={`/admin/policies/${slug}`} className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text mb-4">
        <ChevronLeft size={12} /> {policy.title} — version history
      </Link>

      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h2 className="text-2xl font-bold">{policy.title} · v{version.version_number}</h2>
        {version.is_current && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700">
            Current
          </span>
        )}
      </div>
      <div className="text-xs text-un1t-subtle mb-4">
        Effective {version.effective_date} · published {fmtDateTime(version.published_at)}
        {version.change_summary && <> · {version.change_summary}</>}
      </div>

      <details className="border border-un1t-border rounded-lg mb-6">
        <summary className="px-4 py-3 text-sm cursor-pointer hover:bg-un1t-border/30">
          View body ({version.body_markdown.length.toLocaleString()} characters)
        </summary>
        <article className="bg-white text-gray-900 p-6">
          <div className="whitespace-pre-wrap font-serif text-sm leading-relaxed">
            {version.body_markdown}
          </div>
        </article>
      </details>

      {/* Hot-sections aggregate — surfaces which sections drew the
          most attention across all viewers. Empty until enough data
          accrues. */}
      {hotSections.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-3 inline-flex items-center gap-2">
            <Flame size={12} className="text-amber-700" /> Hot sections
          </h3>
          <div className="border border-un1t-border rounded-lg overflow-hidden">
            {hotSections.slice(0, 10).map((s, i) => (
              <div
                key={s.section}
                className={`px-4 py-2 text-xs flex items-center justify-between gap-3 ${
                  i < hotSections.length - 1 ? 'border-b border-un1t-border' : ''
                }`}
              >
                <span className="text-un1t-text truncate flex-1">{s.section}</span>
                <span className="text-un1t-subtle tabular-nums whitespace-nowrap">
                  {fmtDuration(s.total_seconds)} total · avg {fmtDuration(s.avg_seconds)} across {s.sessions} sessions
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-3 inline-flex items-center gap-2">
            <Eye size={12} className="text-emerald-700" /> Opened ({viewers.length})
          </h3>
          <div className="border border-un1t-border rounded-lg overflow-hidden">
            {viewers.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-un1t-muted">No one has opened this version yet.</div>
            )}
            {viewers.map((v, i) => (
              <div key={v.profile_id} className={`px-4 py-2 text-xs ${i < viewers.length - 1 ? 'border-b border-un1t-border' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-un1t-text truncate">{v.full_name || '—'}</span>
                  <span className="text-un1t-subtle tabular-nums whitespace-nowrap">
                    {v.session_count} {v.session_count === 1 ? 'session' : 'sessions'} · {fmtDuration(v.total_seconds)}
                  </span>
                </div>
                <div className="text-un1t-muted">
                  {v.email} · last {fmtDateTime(v.latest_at)} · {v.latest_via}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-3 inline-flex items-center gap-2">
            <AlertCircle size={12} className="text-amber-700" /> Haven't opened ({outstanding.length})
          </h3>
          <div className="border border-un1t-border rounded-lg overflow-hidden">
            {outstanding.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-un1t-muted">Everyone has opened this version.</div>
            )}
            {outstanding.map((s, i) => (
              <div key={s.id} className={`px-4 py-2 text-xs ${i < outstanding.length - 1 ? 'border-b border-un1t-border' : ''}`}>
                <div className="text-un1t-text">{s.full_name || '—'}</div>
                <div className="text-un1t-muted">{s.email}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
