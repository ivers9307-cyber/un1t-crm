// Settings → Impersonate. Master-only.
//
// Full picker with role/location filters + the master's own
// impersonation audit log. The sidebar dropdown is the fast path;
// this page is for searching past sessions and seeing the full
// picture.

import { redirect } from 'next/navigation'
import { UserCog, History } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import ImpersonatePickerFull from '@/components/ImpersonatePickerFull'

export const dynamic = 'force-dynamic'

export default async function ImpersonatePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // The page is for the REAL master. If currently impersonating,
  // the underlying master can still see this page (we want them to
  // be able to switch targets here too).
  const realMasterId = user.impersonatingFrom?.masterId || (user.role === 'master' ? user.id : null)
  if (!realMasterId) redirect('/')

  const db = createServerClient()
  const [profilesRes, logRes] = await Promise.all([
    db.from('profiles')
      .select('id, full_name, email, role, active, profile_locations(locations(id, name))')
      .order('full_name'),
    db.from('impersonation_log')
      .select('id, target_user_id, started_at, ended_at, reason, profiles!impersonation_log_target_user_id_fkey(full_name, email, role)')
      .eq('master_user_id', realMasterId)
      .order('started_at', { ascending: false })
      .limit(50),
  ])

  const users = (profilesRes.data || [])
    .filter(p => p.id !== realMasterId)
    .map(p => ({
      id: p.id,
      full_name: p.full_name,
      email: p.email,
      role: p.role,
      active: p.active,
      locations: (p.profile_locations || []).map(pl => pl.locations?.name).filter(Boolean),
    }))

  const log = (logRes.data || []).map(row => ({
    id: row.id,
    target_user_id: row.target_user_id,
    target_name: row.profiles?.full_name || '(unknown)',
    target_email: row.profiles?.email,
    target_role: row.profiles?.role,
    started_at: row.started_at,
    ended_at: row.ended_at,
    reason: row.reason,
  }))

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">View as user</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Master-only. Sign in as another user to debug their experience. Every session is logged below — both you and the impersonated user can review their own row in the audit trail.
      </p>

      {user.impersonatingFrom && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-sm rounded-lg p-3 mb-4">
          You are currently viewing as <strong>{user.full_name}</strong>. Pick a different user below to switch, or use the sidebar &ldquo;Stop impersonating&rdquo; button to end the session.
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <UserCog size={16} className="text-un1t-subtle" />
        <h3 className="text-lg font-semibold">Pick a user</h3>
      </div>
      <ImpersonatePickerFull users={users} />

      <div className="flex items-center gap-2 mt-10 mb-3">
        <History size={16} className="text-un1t-subtle" />
        <h3 className="text-lg font-semibold">Recent sessions</h3>
      </div>
      {log.length === 0 ? (
        <p className="text-sm text-un1t-subtle">No impersonation sessions yet.</p>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-un1t-border text-un1t-subtle text-xs uppercase tracking-wider">
                <th className="text-left p-3">User</th>
                <th className="text-left p-3">Started</th>
                <th className="text-left p-3">Ended</th>
                <th className="text-left p-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-un1t-border">
              {log.map(row => (
                <tr key={row.id}>
                  <td className="p-3">
                    <div className="text-sm text-un1t-text">{row.target_name}</div>
                    <div className="text-xs text-un1t-subtle">{row.target_email} · {row.target_role}</div>
                  </td>
                  <td className="p-3 text-xs text-un1t-subtle">{new Date(row.started_at).toLocaleString()}</td>
                  <td className="p-3 text-xs text-un1t-subtle">
                    {row.ended_at
                      ? new Date(row.ended_at).toLocaleString()
                      : <span className="text-amber-400">Active</span>}
                  </td>
                  <td className="p-3 text-xs text-un1t-subtle truncate max-w-[200px]">{row.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
