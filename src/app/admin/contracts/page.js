// /admin/contracts — issuer-side hub. Lists issued contracts for the
// viewer's ORGANIZATION plus a button to issue a new one and a link to
// the templates manager.
//
// CONTRACTS-SCOPE.1 — the list is scoped in app code, NOT by RLS. This
// page renders via createServerClient() (service role), which BYPASSES
// RLS, so the mig 106 policies do nothing here. Without an app-layer
// filter the query returned EVERY org's contracts (recipient names,
// emails, templates, statuses) to anyone who could reach the page —
// mirrors the app-layer model already documented on /api/contracts.
//   master → every contract; else → their active organization only.
//
// STUDIO-GROUP.1 — was master/owner role-gated; now uses the
// `contracts` permission. Default still owner/master via the role
// defaults in shared/permissions.js, but operators can now grant
// access per user from StaffForm.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Plus, FileText, Settings as SettingsIcon, ChevronRight } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

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

const MS_PER_DAY = 1000 * 60 * 60 * 24

// CONTRACTS-REMIND.1 — "awaiting Nd" annotation for issued/viewed rows.
// Diffs two Date instants directly via getTime() (never a
// new Date(`${d}T${t}Z`) template-string parse, never a
// new Date().toISOString().slice/split "today" — both lint-enforced).
function daysAwaiting(issuedAtIso) {
  if (!issuedAtIso) return null
  const ms = Date.now() - new Date(issuedAtIso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.floor(ms / MS_PER_DAY)
}

function AwaitingAnnotation({ status, issuedAt }) {
  if (status !== 'issued' && status !== 'viewed') return null
  const days = daysAwaiting(issuedAt)
  if (days == null) return null
  return (
    <span className="text-[11px] text-un1t-subtle">
      awaiting {days}d
    </span>
  )
}

export default async function ContractsAdminPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'contracts')) redirect('/')

  // CONTRACTS-SCOPE.1 — replicate mig 106's tenant boundary in app code
  // (service role bypasses RLS). Master sees every contract; everyone else
  // is limited to their active organization. A non-master with no active
  // org context has nothing to administer, so we skip the query entirely.
  const db = createServerClient()
  const orgId = user.activeOrganization?.id
  let rows = []
  if (user.isMaster || orgId) {
    let query = db
      .from('contracts')
      .select(`
        id, status, issued_at, signed_at, declined_at, revoked_at,
        profile:profiles!profile_id (id, full_name, email, employment_type),
        template:contract_templates!template_id (name)
      `)
      .order('issued_at', { ascending: false })
    if (!user.isMaster) query = query.eq('organization_id', orgId)
    const { data: contracts } = await query
    rows = contracts || []
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <h2 className="text-2xl font-bold">Contracts</h2>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/contracts/templates"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
          >
            <SettingsIcon size={12} /> Templates
          </Link>
          <Link
            href="/admin/contracts/issue"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Issue contract
          </Link>
        </div>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Send digital contracts to staff and contractors. Each one is countersigned at issue and
        signed by the recipient in their portal.
      </p>

      {rows.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
          <FileText size={28} className="mx-auto text-un1t-subtle mb-3" />
          <p className="text-sm text-un1t-subtle mb-4">No contracts issued yet.</p>
          <Link
            href="/admin/contracts/issue"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Issue your first contract
          </Link>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-un1t-border text-un1t-subtle text-[11px] uppercase tracking-wider">
                  <th className="text-left p-3">Recipient</th>
                  <th className="text-left p-3">Template</th>
                  <th className="text-left p-3">Issued</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-un1t-border">
                {rows.map(r => {
                  const badge = STATUS_BADGE[r.status] || { label: r.status, class: 'bg-un1t-border text-un1t-subtle' }
                  return (
                    <tr key={r.id} className="hover:bg-un1t-border/20">
                      <td className="p-3">
                        <div className="font-medium text-un1t-text">{r.profile?.full_name || '—'}</div>
                        <div className="text-[11px] text-un1t-subtle">{r.profile?.email}</div>
                      </td>
                      <td className="p-3 text-un1t-subtle">{r.template?.name || '—'}</td>
                      <td className="p-3 text-un1t-subtle whitespace-nowrap">{fmtDate(r.issued_at)}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.class}`}>
                            {badge.label}
                          </span>
                          <AwaitingAnnotation status={r.status} issuedAt={r.issued_at} />
                        </div>
                      </td>
                      <td className="p-3 text-right">
                        <Link
                          href={`/admin/contracts/${r.id}`}
                          className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center"
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
              const badge = STATUS_BADGE[r.status] || { label: r.status, class: 'bg-un1t-border text-un1t-subtle' }
              return (
                <Link
                  key={r.id}
                  href={`/admin/contracts/${r.id}`}
                  className="block bg-un1t-surface border border-un1t-border rounded-lg p-3 active:bg-un1t-border/30"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-un1t-text truncate">{r.profile?.full_name || '—'}</div>
                      <div className="text-[11px] text-un1t-subtle truncate">{r.template?.name || '—'}</div>
                    </div>
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${badge.class}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="text-[11px] text-un1t-subtle mt-1 flex items-center gap-2">
                    <span>{fmtDate(r.issued_at)}</span>
                    <AwaitingAnnotation status={r.status} issuedAt={r.issued_at} />
                  </div>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
