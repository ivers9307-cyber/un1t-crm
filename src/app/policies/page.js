// /policies — staff-facing list of HR policies.
//
// No permission gate — every authenticated employee can read the
// policies. Each row shows read/unread status and the most-recent
// version's effective date. Clicking a row goes to the viewer at
// /policies/[slug] where the body renders and the Acknowledge
// button appears.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CheckCircle, AlertCircle, ChevronRight, FileText } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { listPoliciesWithStatus } from '@/lib/policies'

export const dynamic = 'force-dynamic'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export default async function PoliciesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const policies = await listPoliciesWithStatus(user)
  const outstanding = policies.filter((p) => p.current_version && !p.acknowledged_at).length

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">Policies</h2>
      <p className="text-sm text-un1t-light mb-6">
        Read and acknowledge the policies that apply to you. We'll let
        you know when something changes and ask you to re-acknowledge.
      </p>

      {outstanding > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 rounded-md px-4 py-3 mb-5 inline-flex items-center gap-2 text-sm">
          <AlertCircle size={14} />
          You have {outstanding} {outstanding === 1 ? 'policy' : 'policies'} to acknowledge.
        </div>
      )}

      <div className="border border-un1t-gray rounded-lg overflow-hidden">
        {policies.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-un1t-mid">
            No policies published yet.
          </div>
        )}
        {policies.map((p, i) => {
          const acked = !!p.acknowledged_at
          const ver = p.current_version
          return (
            <Link
              key={p.id}
              href={`/policies/${p.slug}`}
              className={`flex items-center gap-4 px-4 py-3 hover:bg-un1t-gray/30 transition-colors ${
                i < policies.length - 1 ? 'border-b border-un1t-gray' : ''
              }`}
            >
              <FileText size={18} className="text-un1t-light shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-un1t-white font-medium truncate">{p.title}</span>
                  {ver && (
                    <span className="text-[10px] uppercase tracking-wider text-un1t-mid">
                      v{ver.version_number}
                    </span>
                  )}
                </div>
                {p.description && (
                  <div className="text-xs text-un1t-light truncate">{p.description}</div>
                )}
                {ver && (
                  <div className="text-[10px] text-un1t-mid mt-0.5">
                    Effective {fmtDate(ver.effective_date)}
                  </div>
                )}
              </div>
              {acked ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 shrink-0">
                  <CheckCircle size={12} /> Acknowledged
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 shrink-0">
                  <AlertCircle size={12} /> Unread
                </span>
              )}
              <ChevronRight size={14} className="text-un1t-mid shrink-0" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
