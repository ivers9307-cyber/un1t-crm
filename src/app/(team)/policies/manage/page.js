// /policies/manage — master/owner-only admin for the policies hub.
// ADMIN.2h Task 1 — moved out of /admin (was /admin/policies) to sit
// alongside the staff-facing read surface at /policies (that page and
// its [slug] detail predate this move and are untouched — this CRUD
// tree lives at /policies/manage so the two don't collide). Gate is
// standalone below (owner|master), unaffected by the move.
// Lists policies with current version + view counts (POLICIES-VIEWS.1
// replaced the previous acknowledgement model). Click a row to drill
// into version history, viewer report, and the publish-new-version form.

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

  // Count UNIQUE viewers (distinct profile_id with at least one
  // completed view of the current version). One row per session
  // would over-count repeat readers.
  const viewerCount = new Map()
  if (currentVersionIds.length > 0) {
    const { data: views } = await db
      .from('policy_views')
      .select('policy_version_id, profile_id, ended_at')
      .in('policy_version_id', currentVersionIds)
      .not('ended_at', 'is', null)
    const setsByVersion = new Map()
    for (const v of views || []) {
      const set = setsByVersion.get(v.policy_version_id) || new Set()
      set.add(v.profile_id)
      setsByVersion.set(v.policy_version_id, set)
    }
    for (const [vid, set] of setsByVersion) viewerCount.set(vid, set.size)
  }

  const { count: activeStaffCount } = await db
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('active', true)

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Policies</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-2xl">
        Manage the policies staff can read. Publishing a new version
        resets the view-tracking state — every active employee shows
        as "not opened" until they next open the new version.
      </p>

      <div className="border border-un1t-border rounded-lg overflow-hidden">
        {(policies || []).map((p, i) => {
          const ver = (p.policy_versions || []).find((v) => v.is_current)
          const viewers = ver ? viewerCount.get(ver.id) || 0 : 0
          return (
            <Link
              key={p.id}
              href={`/policies/manage/${p.slug}`}
              className={`flex items-center gap-4 px-4 py-3 hover:bg-un1t-border/30 transition-colors ${
                i < policies.length - 1 ? 'border-b border-un1t-border' : ''
              }`}
            >
              <FileText size={18} className="text-un1t-subtle shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-un1t-text font-medium truncate">{p.title}</span>
                  {ver && (
                    <span className="text-[10px] uppercase tracking-wider text-un1t-muted">
                      v{ver.version_number}
                    </span>
                  )}
                  {!p.active && (
                    <span className="text-[10px] uppercase tracking-wider text-un1t-muted bg-un1t-border/40 px-1.5 py-0.5 rounded">
                      Archived
                    </span>
                  )}
                </div>
                <div className="text-xs text-un1t-subtle truncate">
                  {ver
                    ? `Effective ${fmtDate(ver.effective_date)} · published ${fmtDate(ver.published_at)}`
                    : 'No version published'}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm text-un1t-text tabular-nums">
                  {viewers}
                  {activeStaffCount != null && <span className="text-un1t-muted"> / {activeStaffCount}</span>}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-un1t-muted">opened</div>
              </div>
              <ChevronRight size={14} className="text-un1t-muted shrink-0" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
