// /admin/contracts/[id] — issuer's view of one contract.
// Shows status, both signatures (when present), the rendered body,
// and offers Revoke (only for issued/viewed) and a Print/Save-PDF
// affordance.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import ContractRevokeButton from '@/components/ContractRevokeButton'
import ContractPrintButton from '@/components/ContractPrintButton'

export const dynamic = 'force-dynamic'
export const revalidate = 0

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

export default async function ContractDetailAdmin({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isOwnerOrMaster(user)) redirect('/')

  const db = createServerClient()
  const { data: c } = await db
    .from('contracts')
    .select(`
      *,
      profile:profiles!profile_id (id, full_name, email, role, employment_type),
      issuer:profiles!issued_by (id, full_name, email),
      template:contract_templates!template_id (name, version)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (!c) notFound()

  const badge = STATUS_BADGE[c.status] || { label: c.status, class: 'bg-un1t-gray text-un1t-light' }
  const canRevoke = c.status === 'issued' || c.status === 'viewed'

  return (
    <div className="p-6 md:p-8 max-w-3xl print:p-0 print:max-w-none">
      <div className="print:hidden">
        <Link href="/admin/contracts" className="text-xs text-un1t-light hover:text-un1t-white">
          ← Contracts
        </Link>
        <div className="flex items-start justify-between gap-3 mt-1 mb-4">
          <div>
            <h2 className="text-2xl font-bold">{c.template?.name || 'Contract'}</h2>
            <p className="text-xs text-un1t-light">v{c.template?.version} · issued {fmtDate(c.issued_at)}</p>
          </div>
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.class}`}>
            {badge.label}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 print:hidden">
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light mb-1">Recipient</p>
          <p className="font-medium text-un1t-white">{c.profile?.full_name}</p>
          <p className="text-[11px] text-un1t-light">{c.profile?.email}</p>
          <p className="text-[11px] text-un1t-mid mt-1">{c.profile?.employment_type} · {c.profile?.role}</p>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-xs text-un1t-light mb-1">Issued by</p>
          <p className="font-medium text-un1t-white">{c.issuer?.full_name}</p>
          <p className="text-[11px] text-un1t-light">{c.issuer?.email}</p>
        </div>
      </div>

      {c.status === 'declined' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-xs font-semibold text-red-700">Declined {fmtDate(c.declined_at)}</p>
          {c.declined_reason && <p className="text-sm text-red-700 mt-1">{c.declined_reason}</p>}
        </div>
      )}
      {c.status === 'revoked' && (
        <div className="bg-gray-500/10 border border-gray-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-xs font-semibold text-un1t-light">Revoked {fmtDate(c.revoked_at)}</p>
          {c.revoked_reason && <p className="text-sm text-un1t-light mt-1">{c.revoked_reason}</p>}
        </div>
      )}

      {/* Print-friendly contract body */}
      <article className="bg-white text-gray-900 rounded-lg p-6 md:p-8 mb-6 print:rounded-none print:p-0 print:bg-white">
        <div className="whitespace-pre-wrap font-serif text-sm md:text-base leading-relaxed">
          {c.body_rendered}
        </div>

        {/* Dual signature block */}
        <div className="mt-10 pt-6 border-t border-gray-300 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <SignatureBlock
            label="For UN1T Dublin Ltd"
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
        {canRevoke && <ContractRevokeButton contractId={c.id} />}
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
