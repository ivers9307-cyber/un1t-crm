// /account/access-history — self-service audit page.
//
// Shows every impersonation_log row where the current user was the
// target. RLS already permits this (mig 035 — targets can SELECT
// rows where target_user_id = auth.uid()), so the page just needs
// to read and render.
//
// Visible to all authenticated users. Empty state for users who've
// never been impersonated. Useful trust-and-safety affordance —
// nobody can quietly view a user's experience without them being
// able to verify it later.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, Eye, ShieldAlert } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export default async function AccessHistoryPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: log } = await db
    .from('impersonation_log')
    .select('id, master_user_id, started_at, ended_at, reason, ip, profiles!impersonation_log_master_user_id_fkey(full_name, email)')
    .eq('target_user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(100)

  const rows = (log || []).map(r => ({
    id: r.id,
    masterName: r.profiles?.full_name || '(unknown master)',
    masterEmail: r.profiles?.email,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    reason: r.reason,
    ip: r.ip,
  }))

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/" className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white mb-3">
        <ChevronLeft size={14} /> Back
      </Link>
      <h2 className="text-2xl font-bold mb-1">Account access history</h2>
      <p className="text-sm text-un1t-light mb-6">
        A record of every time a master account has signed in as you to debug your experience. The CRM&rsquo;s &ldquo;view as user&rdquo; feature (Settings → Master tools) is master-only and always logged here for transparency.
      </p>

      {rows.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-10 text-center">
          <ShieldAlert size={32} className="mx-auto mb-3 text-un1t-light" />
          <h3 className="text-base font-semibold mb-2">No access events</h3>
          <p className="text-sm text-un1t-light">
            Nobody has signed in as you. If a master ever does, the row appears here automatically.
          </p>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-un1t-gray text-un1t-light text-xs uppercase tracking-wider">
                <th className="text-left p-3">Signed in as me</th>
                <th className="text-left p-3">Started</th>
                <th className="text-left p-3">Ended</th>
                <th className="text-left p-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-un1t-gray">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Eye size={14} className="text-amber-400 shrink-0" />
                      <div>
                        <div className="text-sm text-un1t-white">{r.masterName}</div>
                        <div className="text-xs text-un1t-light">{r.masterEmail}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-xs text-un1t-light whitespace-nowrap">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="p-3 text-xs text-un1t-light whitespace-nowrap">
                    {r.endedAt
                      ? new Date(r.endedAt).toLocaleString()
                      : <span className="text-amber-400">Active</span>}
                  </td>
                  <td className="p-3 text-xs text-un1t-light truncate max-w-[260px]" title={r.reason || ''}>{r.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[11px] text-un1t-mid">
        Concerned about an entry? Click the user&rsquo;s name (when listed) to message them, or reach out to your platform admin directly.
      </p>
    </div>
  )
}
