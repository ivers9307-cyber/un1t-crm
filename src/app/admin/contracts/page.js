// /admin/contracts — issuer-side hub. Shows all issued contracts
// for the org (RLS handles the filter) plus a button to issue a
// new one and a link to the templates manager.
//
// Master/owner only — gated server-side here AND by RLS on the
// contracts/contract_templates tables (mig 106).

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, FileText, Settings as SettingsIcon, ChevronRight } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

const STATUS_BADGE = {
  issued:   { label: 'Sent',     class: 'bg-blue-500/15 text-blue-700' },
  viewed:   { label: 'Viewed',   class: 'bg-amber-500/15 text-amber-700' },
  signed:   { label: 'Signed',   class: 'bg-emerald-500/15 text-emerald-700' },
  declined: { label: 'Declined', class: 'bg-red-500/15 text-red-700' },
  revoked:  { label: 'Revoked',  class: 'bg-gray-500/15 text-gray-600' },
  draft:    { label: 'Draft',    class: 'bg-purple-500/15 text-purple-700' },
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default async function ContractsAdminPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  const { data: contracts } = await db
    .from('contracts')
    .select(`
      id, status, issued_at, signed_at, declined_at, revoked_at,
      profile:profiles!profile_id (id, full_name, email, employment_type),
      template:contract_templates!template_id (name)
    `)
    .order('issued_at', { ascending: false })

  const rows = contracts || []

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <h2 className="text-2xl font-bold">Contracts</h2>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/contracts/templates"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white"
          >
            <SettingsIcon size={12} /> Templates
          </Link>
          <Link
            href="/admin/contracts/issue"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Issue contract
          </Link>
        </div>
      </div>
      <p className="text-sm text-un1t-light mb-6">
        Send digital contracts to staff and contractors. Each one is countersigned at issue and
        signed by the recipient in their portal.
      </p>

      {rows.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center">
          <FileText size={28} className="mx-auto text-un1t-light mb-3" />
          <p className="text-sm text-un1t-light mb-4">No contracts issued yet.</p>
          <Link
            href="/admin/contracts/issue"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Issue your first contract
          </Link>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-un1t-gray text-un1t-light text-[11px] uppercase tracking-wider">
                  <th className="text-left p-3">Recipient</th>
                  <th className="text-left p-3">Template</th>
                  <th className="text-left p-3">Issued</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-un1t-gray">
                {rows.map(r => {
                  const badge = STATUS_BADGE[r.status] || { label: r.status, class: 'bg-un1t-gray text-un1t-light' }
                  return (
                    <tr key={r.id} className="hover:bg-un1t-gray/20">
                      <td className="p-3">
                        <div className="font-medium text-un1t-white">{r.profile?.full_name || '—'}</div>
                        <div className="text-[11px] text-un1t-light">{r.profile?.email}</div>
                      </td>
                      <td className="p-3 text-un1t-light">{r.template?.name || '—'}</td>
                      <td className="p-3 text-un1t-light whitespace-nowrap">{fmtDate(r.issued_at)}</td>
                      <td className="p-3">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.class}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <Link
                          href={`/admin/contracts/${r.id}`}
                          className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center"
                        >
                          Open <ChevronRight size={12} className="ml-0.5" />
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-2">
            {rows.map(r => {
              const badge = STATUS_BADGE[r.status] || { label: r.status, class: 'bg-un1t-gray text-un1t-light' }
              return (
                <Link
                  key={r.id}
                  href={`/admin/contracts/${r.id}`}
                  className="block bg-un1t-dark border border-un1t-gray rounded-lg p-3 active:bg-un1t-gray/30"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-un1t-white truncate">{r.profile?.full_name || '—'}</div>
                      <div className="text-[11px] text-un1t-light truncate">{r.template?.name || '—'}</div>
                    </div>
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${badge.class}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="text-[11px] text-un1t-light mt-1">{fmtDate(r.issued_at)}</div>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
