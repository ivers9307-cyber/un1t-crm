// /policies/[slug] — viewer for a single policy.
//
// Server-renders the title block and hands the body off to the
// client-side PolicyViewTracker, which is responsible for:
//   - opening a view session (POST /views)
//   - tracking per-section dwell
//   - flushing total + dwell back to the server on unload
//
// No "Acknowledge" CTA — POLICIES-VIEWS.1 replaced explicit
// acknowledgement with passive view tracking. The page just shows
// "first opened on X" / "last opened on X" if the user has any
// completed views of the current version.

import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, Eye } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { getPolicyBySlug } from '@/lib/policies'
import PolicyViewTracker from '@/components/PolicyViewTracker'

export const dynamic = 'force-dynamic'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}
function fmtDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default async function PolicyViewerPage({ params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const policy = await getPolicyBySlug(slug, user)
  if (!policy) notFound()
  const ver = policy.current_version

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      <Link href="/policies" className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white mb-4">
        <ChevronLeft size={12} /> All policies
      </Link>

      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h2 className="text-2xl font-bold">{policy.title}</h2>
        {ver && (
          <span className="text-xs text-un1t-light">
            v{ver.version_number} · effective {fmtDate(ver.effective_date)}
          </span>
        )}
      </div>
      {policy.description && (
        <p className="text-sm text-un1t-light mb-2">{policy.description}</p>
      )}
      {ver?.change_summary && ver.version_number > 1 && (
        <div className="bg-blue-500/10 border border-blue-500/30 text-blue-700 rounded-md px-3 py-2 mt-3 mb-2 text-xs">
          <strong className="font-semibold">What changed in v{ver.version_number}:</strong>{' '}
          {ver.change_summary}
        </div>
      )}
      {policy.viewed_at && (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-un1t-light">
          <Eye size={11} />
          You last opened this version on {fmtDateTime(policy.viewed_at)}
          {policy.view_count > 1 && ` · ${policy.view_count} sessions`}
        </div>
      )}

      {!ver && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md px-3 py-2 my-6">
          This policy has no published version yet.
        </div>
      )}

      {ver && (
        <PolicyViewTracker slug={policy.slug} body={ver.body_markdown} />
      )}
    </div>
  )
}
