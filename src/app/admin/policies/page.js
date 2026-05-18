// /admin/policies — master/owner-only admin for the policies hub.
// Lists policies with current version + ack counts. Click a row to
// drill into version history, ack report, and publish-new-version.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight, FileText } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner' || user?.profileRole === 'master'
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function AdminPoliciesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  // Pull policies + their current versions + the ack count for that
  // version. Two queries to keep the SQL legible.
  const { data: policies } = await db
    .from('policies')
    .select(`
      id, slug, title, description, active, display_order, created_at,
      policy_versions ( id, version_number, effective_date, published_at, is_current )
    `)
    .order('active', { ascending: false })
    .order('display_order')

  const currentVersionIds = (policies || [])
    .map((p) => (p.policy_versions || []).find((v) => v.is_current)?.id)
    .filter(Boolean)

  let ackCounts = new Map()
  if (currentVersionIds.length > 0) {
    const { data: acks } = await db
      .from('policy_acknowledgements')
      .select('policy_version_id')
      .in('policy_version_id', currentVersionIds)
    for (const a of acks || []) {
      ackCounts.set(a.policy_version_id, (ackCounts.get(a.policy_version_id) || 0) + 1)
    }
  }

  // Total active employee count for the "X / Y acknowledged" display.
  const { count: activeStaffCount } = await db
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('active', true)

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Policies</h2>
      <p className="text-sm text-un1t-light mb-6 max-w-2xl">
        Manage the policies staff are required to acknowledge. Publishing
        a new version of any policy resets acknowledgements — every
        active employee will be prompted to read and re-acknowledge.
      </p>

      <div className="border border-un1t-gray rounded-lg overflow-hidden">
        {(policies || []).map((p, i) => {
          const ver = (p.policy_versions || []).find((v) => v.is_current)
          const acks = ver ? ackCounts.get(ver.id) || 0 : 0
          return (
            <Link
              key={p.id}
              href={`/admin/policies/${p.slug}`}
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
                  {!p.active && (
                    <span className="text-[10px] uppercase tracking-wider text-un1t-mid bg-un1t-gray/40 px-1.5 py-0.5 rounded">
                      Archived
                    </span>
                  )}
                </div>
                <div className="text-xs text-un1t-light truncate">
                  {ver
                    ? `Effective ${fmtDate(ver.effective_date)} · published ${fmtDate(ver.published_at)}`
                    : 'No version published'}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm text-un1t-white tabular-nums">
                  {acks}
                  {activeStaffCount != null && <span className="text-un1t-mid"> / {activeStaffCount}</span>}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-un1t-mid">acknowledged</div>
              </div>
              <ChevronRight size={14} className="text-un1t-mid shrink-0" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
