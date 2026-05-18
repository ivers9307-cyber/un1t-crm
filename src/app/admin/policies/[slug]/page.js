// /admin/policies/[slug] — admin detail page for a single policy.
// Shows version history (newest first), ack count per version, and a
// "Publish new version" form. Click into a version to see who's
// acknowledged it.

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listVersions } from '@/lib/policies'
import PublishPolicyVersionForm from '@/components/PublishPolicyVersionForm'

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

export default async function AdminPolicyDetailPage({ params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  const { data: policy } = await db
    .from('policies')
    .select('id, slug, title, description, active')
    .eq('slug', slug)
    .maybeSingle()
  if (!policy) notFound()

  const versions = await listVersions(policy.id)
  const currentVersion = versions.find((v) => v.is_current)

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <Link href="/admin/policies" className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white mb-4">
        <ChevronLeft size={12} /> All policies
      </Link>

      <h2 className="text-2xl font-bold mb-1">{policy.title}</h2>
      {policy.description && (
        <p className="text-sm text-un1t-light mb-6 max-w-2xl">{policy.description}</p>
      )}

      <section className="mb-8">
        <h3 className="text-xs uppercase tracking-wider text-un1t-light font-semibold mb-3">Version history</h3>
        <div className="border border-un1t-gray rounded-lg overflow-hidden">
          {versions.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-un1t-mid">No versions yet.</div>
          )}
          {versions.map((v, i) => (
            <Link
              key={v.id}
              href={`/admin/policies/${policy.slug}/versions/${v.version_number}`}
              className={`flex items-center gap-4 px-4 py-3 hover:bg-un1t-gray/30 transition-colors ${
                i < versions.length - 1 ? 'border-b border-un1t-gray' : ''
              }`}
            >
              <div className="text-xs uppercase tracking-wider text-un1t-mid w-12 shrink-0">v{v.version_number}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-un1t-white">
                    Effective {v.effective_date}
                  </span>
                  {v.is_current && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-un1t-light">
                  Published {fmtDateTime(v.published_at)}
                  {v.change_summary && ` · ${v.change_summary}`}
                </div>
              </div>
              <div className="text-sm tabular-nums text-un1t-white shrink-0">{v.ack_count}</div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-wider text-un1t-light font-semibold mb-3">Publish new version</h3>
        <PublishPolicyVersionForm slug={policy.slug} nextVersionNumber={(currentVersion?.version_number || 0) + 1} />
      </section>
    </div>
  )
}
