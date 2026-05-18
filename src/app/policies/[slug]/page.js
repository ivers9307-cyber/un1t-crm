// /policies/[slug] — viewer for a single policy.
//
// Server-renders the current version body and shows the Acknowledge
// button (client component) at the bottom. Body renders as
// whitespace-pre-wrap on a serif font, same approach used by
// contracts — preserves the structure of the policy document
// without depending on a markdown library.

import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, CheckCircle } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { getPolicyBySlug } from '@/lib/policies'
import AcknowledgePolicyButton from '@/components/AcknowledgePolicyButton'

export const dynamic = 'force-dynamic'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export default async function PolicyViewerPage({ params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const policy = await getPolicyBySlug(slug, user)
  if (!policy) notFound()
  const ver = policy.current_version
  const acked = !!policy.acknowledged_at

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
        <div className="bg-blue-500/10 border border-blue-500/30 text-blue-700 rounded-md px-3 py-2 mt-3 mb-4 text-xs">
          <strong className="font-semibold">What changed in v{ver.version_number}:</strong>{' '}
          {ver.change_summary}
        </div>
      )}

      {!ver && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md px-3 py-2 my-6">
          This policy has no published version yet.
        </div>
      )}

      {ver && (
        <article className="bg-white text-gray-900 rounded-lg p-6 md:p-8 my-6 border border-un1t-gray">
          <div className="whitespace-pre-wrap font-serif text-sm md:text-base leading-relaxed">
            {ver.body_markdown}
          </div>
        </article>
      )}

      {ver && (
        <div className="border-t border-un1t-gray pt-5">
          {acked ? (
            <div className="inline-flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle size={14} />
              You acknowledged v{ver.version_number} on {fmtDate(policy.acknowledged_at)}
            </div>
          ) : (
            <AcknowledgePolicyButton slug={policy.slug} versionNumber={ver.version_number} />
          )}
        </div>
      )}
    </div>
  )
}
