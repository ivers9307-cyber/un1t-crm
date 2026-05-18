// /admin/policies/[slug]/versions/[versionNumber] — admin per-version
// view showing the body and a "who's acknowledged / who's outstanding"
// report. Used to chase outstanding acks ahead of an audit or after
// a material change.

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft, CheckCircle, AlertCircle } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

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

  // Ack list + outstanding-staff list.
  const [acksRes, staffRes] = await Promise.all([
    db.from('policy_acknowledgements')
      .select('profile_id, acknowledged_at, acknowledged_via, profiles!profile_id(full_name, email)')
      .eq('policy_version_id', version.id)
      .order('acknowledged_at'),
    db.from('profiles')
      .select('id, full_name, email')
      .eq('active', true)
      .order('full_name'),
  ])
  const acks = acksRes.data || []
  const ackedIds = new Set(acks.map((a) => a.profile_id))
  const outstanding = (staffRes.data || []).filter((s) => !ackedIds.has(s.id))

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <Link href={`/admin/policies/${slug}`} className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white mb-4">
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
      <div className="text-xs text-un1t-light mb-4">
        Effective {version.effective_date} · published {fmtDateTime(version.published_at)}
        {version.change_summary && <> · {version.change_summary}</>}
      </div>

      <details className="border border-un1t-gray rounded-lg mb-6">
        <summary className="px-4 py-3 text-sm cursor-pointer hover:bg-un1t-gray/30">
          View body ({version.body_markdown.length.toLocaleString()} characters)
        </summary>
        <article className="bg-white text-gray-900 p-6">
          <div className="whitespace-pre-wrap font-serif text-sm leading-relaxed">
            {version.body_markdown}
          </div>
        </article>
      </details>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-xs uppercase tracking-wider text-un1t-light font-semibold mb-3 inline-flex items-center gap-2">
            <CheckCircle size={12} className="text-emerald-700" /> Acknowledged ({acks.length})
          </h3>
          <div className="border border-un1t-gray rounded-lg overflow-hidden">
            {acks.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-un1t-mid">No acknowledgements yet.</div>
            )}
            {acks.map((a, i) => (
              <div key={a.profile_id} className={`px-4 py-2 text-xs ${i < acks.length - 1 ? 'border-b border-un1t-gray' : ''}`}>
                <div className="text-un1t-white">{a.profiles?.full_name || '—'}</div>
                <div className="text-un1t-mid">
                  {a.profiles?.email} · {fmtDateTime(a.acknowledged_at)} · {a.acknowledged_via}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-xs uppercase tracking-wider text-un1t-light font-semibold mb-3 inline-flex items-center gap-2">
            <AlertCircle size={12} className="text-amber-700" /> Outstanding ({outstanding.length})
          </h3>
          <div className="border border-un1t-gray rounded-lg overflow-hidden">
            {outstanding.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-un1t-mid">Everyone is up to date.</div>
            )}
            {outstanding.map((s, i) => (
              <div key={s.id} className={`px-4 py-2 text-xs ${i < outstanding.length - 1 ? 'border-b border-un1t-gray' : ''}`}>
                <div className="text-un1t-white">{s.full_name || '—'}</div>
                <div className="text-un1t-mid">{s.email}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
