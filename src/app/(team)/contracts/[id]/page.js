// /contracts/[id] — issuer's view of one contract (moved from
// /admin/contracts/[id], HUBS.2d).
// Shows status, both signatures (when present), the rendered body,
// and offers Revoke (only for issued/viewed) and a Print/Save-PDF
// affordance.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { contractCountersignatureLabel } from '@/lib/contracting-entity'
import ContractRevokeButton from '@/components/ContractRevokeButton'
import ContractResendButton from '@/components/ContractResendButton'
import ContractPrintButton from '@/components/ContractPrintButton'
import ContractBody from '@/components/ContractBody'
import ContractIssueWarningBanner from '@/components/ContractIssueWarningBanner'
import ContractDraftActions from '@/components/ContractDraftActions'

export const dynamic = 'force-dynamic'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

const STATUS_BADGE = {
  issued:   { label: 'Sent · awaiting signature', class: 'bg-blue-500/15 text-blue-700' },
  viewed:   { label: 'Viewed · awaiting signature', class: 'bg-amber-500/15 text-amber-700' },
  signed:   { label: 'Signed', class: 'bg-emerald-500/15 text-emerald-700' },
  declined: { label: 'Declined', class: 'bg-red-500/15 text-red-700' },
  revoked:  { label: 'Revoked', class: 'bg-gray-500/15 text-gray-600' },
  draft:    { label: 'Draft', class: 'bg-purple-500/15 text-purple-700' },
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default async function ContractDetailAdmin(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // CONTRACTS-GATES.1 — read surface follows the grantable `contracts`
  // permission (mirrors the list page); the Revoke action below stays
  // owner/master-only via the local isOwnerOrMaster check.
  if (!hasPermission(user, 'contracts')) redirect('/')

  // CONTRACTS-SCOPE.1 — service role bypasses RLS, so scope by org in app
  // code: a non-master (e.g. an owner of one studio) must not be able to
  // open another tenant's contract by guessing its id. 404 (notFound)
  // keeps ids non-enumerable.
  const orgId = user.activeOrganization?.id
  if (!user.isMaster && !orgId) notFound()
  const db = createServerClient()
  let q = db
    .from('contracts')
    .select(`
      *,
      profile:profiles!profile_id (id, full_name, email, role, employment_type),
      issuer:profiles!issued_by (id, full_name, email),
      template:contract_templates!template_id (name, version)
    `)
    .eq('id', params.id)
  if (!user.isMaster) q = q.eq('organization_id', orgId)
  const { data: c } = await q.maybeSingle()
  if (!c) notFound()

  // LEGALENT.1 — the countersignature label asserts the CONTRACTING
  // COMPANY. It is read from the contract's own FROZEN variables_data,
  // never resolved live: a contract issued since LEGALENT.1 carries the
  // entity beside its frozen body, and one issued before it keeps what
  // it was issued and signed under. Same helper as the recipient page,
  // the mobile screen and the stored PDF, so the four can never
  // disagree about who the document is with.
  const entityLabel = contractCountersignatureLabel(c)

  const badge = STATUS_BADGE[c.status] || { label: c.status, class: 'bg-un1t-border text-un1t-subtle' }
  // Both actions share the same gate (issued/viewed + owner/master) —
  // resend is the notification-replay twin of revoke, so it stays
  // owner/master-only rather than following the grantable read
  // permission that gates this page.
  const canManage = (c.status === 'issued' || c.status === 'viewed') && isOwnerOrMaster(user)
  const canRevoke = canManage
  const canResend = canManage
  // CONTRACTS-DRAFT.1 — draft management + re-issue affordances.
  const canManageDraft = c.status === 'draft' && isOwnerOrMaster(user)
  const canReissue = (c.status === 'revoked' || c.status === 'declined') && isOwnerOrMaster(user)

  return (
    <div className="p-6 md:p-8 max-w-3xl print:p-0 print:max-w-none">
      <ContractIssueWarningBanner contractId={c.id} />
      <div className="print:hidden">
        <Link href="/contracts" className="text-xs text-un1t-subtle hover:text-un1t-text">
          ← Contracts
        </Link>
        <div className="flex items-start justify-between gap-3 mt-1 mb-4">
          <div>
            <h2 className="text-2xl font-bold">{c.template?.name || 'Contract'}</h2>
            <p className="text-xs text-un1t-subtle">v{c.template?.version} · issued {fmtDate(c.issued_at)}</p>
          </div>
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.class}`}>
            {badge.label}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 print:hidden">
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-xs text-un1t-subtle mb-1">Recipient</p>
          <p className="font-medium text-un1t-text">{c.profile?.full_name}</p>
          <p className="text-[11px] text-un1t-subtle">{c.profile?.email}</p>
          <p className="text-[11px] text-un1t-muted mt-1">{c.profile?.employment_type} · {c.profile?.role}</p>
        </div>
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-xs text-un1t-subtle mb-1">Issued by</p>
          <p className="font-medium text-un1t-text">{c.issuer?.full_name}</p>
          <p className="text-[11px] text-un1t-subtle">{c.issuer?.email}</p>
        </div>
      </div>

      {c.status === 'draft' && (
        <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-sm font-semibold text-purple-700">Draft. The recipient has not been notified yet.</p>
        </div>
      )}
      {c.status === 'declined' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-xs font-semibold text-red-700">Declined {fmtDate(c.declined_at)}</p>
          {c.declined_reason && <p className="text-sm text-red-700 mt-1">{c.declined_reason}</p>}
        </div>
      )}
      {c.status === 'revoked' && (
        <div className="bg-gray-500/10 border border-gray-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-xs font-semibold text-un1t-subtle">Revoked {fmtDate(c.revoked_at)}</p>
          {c.revoked_reason && <p className="text-sm text-un1t-subtle mt-1">{c.revoked_reason}</p>}
        </div>
      )}

      {/* Print-friendly contract body */}
      <article className="bg-white text-gray-900 rounded-lg p-6 md:p-8 mb-6 print:rounded-none print:p-0 print:bg-white">
        <ContractBody markdown={c.body_rendered} />

        {/* Dual signature block */}
        <div className="mt-10 pt-6 border-t border-gray-300 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <SignatureBlock
            label={`For ${entityLabel}`}
            name={c.issuer_signature}
            timestamp={c.issued_at}
          />
          {c.status === 'signed' ? (
            <SignatureBlock
              label="Employee / Contractor"
              name={c.signature_value}
              timestamp={c.signed_at}
              ip={c.signed_ip}
            />
          ) : (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Employee / Contractor</p>
              <p className="mt-2 italic text-gray-400 text-sm">Awaiting signature</p>
            </div>
          )}
        </div>
      </article>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <ContractPrintButton />
        {/* CONTRACTS-PDF.1 — the stored dual-signed artifact. Plain <a>
            (not <Link>) because the route 302s to a signed Storage URL,
            which is a real navigation, not a client-side route. */}
        {c.signed_pdf_path && (
          <a
            href={`/api/contracts/${c.id}/pdf`}
            className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
          >Download PDF</a>
        )}
        {canResend && <ContractResendButton contractId={c.id} />}
        {canRevoke && (
          <>
            <ContractRevokeButton contractId={c.id} />
            <ContractRevokeButton contractId={c.id} reissueAfter={c.id} label="Revoke & re-issue" />
          </>
        )}
        {canManageDraft && <ContractDraftActions contractId={c.id} />}
        {canReissue && (
          <Link
            href={`/contracts/issue?from=${c.id}`}
            className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
          >Re-issue</Link>
        )}
      </div>

      <style>{`
        @media print {
          body { background: white; }
        }
      `}</style>
    </div>
  )
}

function SignatureBlock({ label, name, timestamp, ip }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-2 font-serif text-2xl italic" style={{ fontFamily: 'Georgia, serif' }}>
        {name || ''}
      </p>
      <p className="text-[10px] text-gray-500 mt-1">
        Signed {new Date(timestamp).toLocaleString('en-IE', { timeZone: 'Europe/Dublin' })}
        {ip ? ` · ${ip}` : ''}
      </p>
    </div>
  )
}
