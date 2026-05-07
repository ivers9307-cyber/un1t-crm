// /account/contracts — recipient's view of their own contracts.
// Lists everything regardless of status so they can re-open
// signed contracts later (employer copy lives elsewhere; this is
// the employee's persistent record of their signed agreements).

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { FileText, ChevronRight } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const STATUS_BADGE = {
  issued:   { label: 'Awaiting your signature', class: 'bg-blue-500/15 text-blue-700' },
  viewed:   { label: 'Awaiting your signature', class: 'bg-amber-500/15 text-amber-700' },
  signed:   { label: 'Signed', class: 'bg-emerald-500/15 text-emerald-700' },
  declined: { label: 'Declined', class: 'bg-red-500/15 text-red-700' },
  revoked:  { label: 'Withdrawn', class: 'bg-gray-500/15 text-gray-600' },
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export default async function MyContractsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: contracts } = await db
    .from('contracts')
    .select(`
      id, status, issued_at, signed_at,
      template:contract_templates!template_id (name)
    `)
    .eq('profile_id', user.id)
    .order('issued_at', { ascending: false })

  const rows = contracts || []
  const pending = rows.filter(r => r.status === 'issued' || r.status === 'viewed')
  const archive = rows.filter(r => r.status !== 'issued' && r.status !== 'viewed')

  return (
    <div className="p-6 md:p-8 max-w-3xl">
      <Link href="/account" className="text-xs text-un1t-light hover:text-un1t-white">
        ← Account
      </Link>
      <h2 className="text-2xl font-bold mt-1 mb-2">Your contracts</h2>
      <p className="text-sm text-un1t-light mb-6">
        Documents UN1T Dublin has issued to you. Sign pending contracts to confirm receipt;
        signed copies stay here for your records.
      </p>

      {rows.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center">
          <FileText size={28} className="mx-auto text-un1t-light mb-3" />
          <p className="text-sm text-un1t-light">No contracts on file yet.</p>
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <section className="mb-8">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">
                Action required ({pending.length})
              </h3>
              <ContractList rows={pending} />
            </section>
          )}
          {archive.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-2">
                Archive
              </h3>
              <ContractList rows={archive} />
            </section>
          )}
        </>
      )}
    </div>
  )
}

function ContractList({ rows }) {
  return (
    <div className="space-y-2">
      {rows.map(r => {
        const badge = STATUS_BADGE[r.status] || { label: r.status, class: 'bg-un1t-gray text-un1t-light' }
        return (
          <Link
            key={r.id}
            href={`/account/contracts/${r.id}`}
            className="block bg-un1t-dark border border-un1t-gray rounded-lg p-4 hover:border-un1t-mid/60"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-un1t-white">{r.template?.name || 'Contract'}</div>
                <div className="text-[11px] text-un1t-light mt-0.5">
                  Issued {fmtDate(r.issued_at)}
                  {r.signed_at && ` · Signed ${fmtDate(r.signed_at)}`}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.class}`}>
                  {badge.label}
                </span>
                <ChevronRight size={16} className="text-un1t-mid" />
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
